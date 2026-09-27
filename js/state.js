/**
 * js/state.js - Reactive State Store & Manifest Reconciliation Layer
 * 
 * Responsibilities:
 *  - Dynamic single-source versioning (reads 'version' from manifest.json)
 *  - Non-destructive delta reconciliation of decks and cards
 *  - Spaced repetition error-weight tracking & local persistence
 *  - Multi-tier group/unit hierarchy indexing with character preview tokens
 */

export class Store extends EventTarget {
  static STORAGE_KEY = "speedrecall_state_v2";
  static MANIFEST_PATH = "./data/manifest.json";

  constructor() {
    super();
    this.decks = {};
    this.currentDeckId = "";
    this.activeMode = "standard";
    this.manifestVersion = 0;
    
    // Set of active category keys: Set<"GroupName::UnitName">
    this.selectedUnits = new Set();

    // Session Statistics
    this.stats = {
      correct: 0,
      attempts: 0,
      streak: 0
    };

    this.isInitialized = false;
  }

  /**
   * Bootstraps store: loads local snapshot, reconciles with manifest delta.
   */
  async init() {
    const raw = localStorage.getItem(Store.STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        this.decks = parsed.decks || {};
        this.currentDeckId = parsed.currentDeckId || "";
        this.activeMode = parsed.activeMode || "standard";
        this.manifestVersion = parsed.manifestVersion || 0;
      } catch (err) {
        console.warn("Corrupt local state. Initiating clean manifest fetch.", err);
      }
    }

    // Reconcile manifest updates without clobbering existing card weights
    await this.syncWithManifest();

    // Fallback deck selection if empty or invalid
    if (!this.currentDeckId || !this.decks[this.currentDeckId]) {
      this.currentDeckId = Object.keys(this.decks)[0] || "";
    }

    this.selectAllUnitsForCurrentDeck();
    this.isInitialized = true;
    this.dispatchEvent(new CustomEvent("initialized"));
  }

  /**
   * Fetches data/manifest.json. Ingests new decks and updates modified cards
   * while preserving learned repetition weights and accuracy records.
   */
  async syncWithManifest() {
    try {
      // Cache-busting query parameter ensures latest manifest fetch on network availability
      const manifestRes = await fetch(`${Store.MANIFEST_PATH}?t=${Date.now()}`);
      if (!manifestRes.ok) return;
      const manifest = await manifestRes.json();

      const manifestVer = manifest.version || 1;
      const isInitial = Object.keys(this.decks).length === 0;
      const isNewVersion = manifestVer > this.manifestVersion;

      if (isInitial || isNewVersion) {
        await Promise.all(
          manifest.decks.map(async (entry) => {
            // Fetch if the deck is completely new or the manifest version bumped
            if (!this.decks[entry.id] || isNewVersion) {
              try {
                const deckRes = await fetch(`${entry.file}?t=${Date.now()}`);
                if (!deckRes.ok) return;
                const deckData = await deckRes.json();

                if (!this.decks[entry.id]) {
                  // Register new deck cleanly
                  this.decks[entry.id] = {
                    name: deckData.name || entry.name,
                    defaultMode: entry.defaultMode || "standard",
                    cards: deckData.cards || []
                  };
                } else {
                  // Non-destructive update: preserve weights of known cards
                  const existingWeights = new Map(
                    this.decks[entry.id].cards.map((c) => [c.id, c.weight])
                  );

                  this.decks[entry.id].name = deckData.name || entry.name;
                  this.decks[entry.id].cards = deckData.cards.map((card) => ({
                    ...card,
                    weight: existingWeights.get(card.id) ?? (card.weight || 1.0)
                  }));
                }
              } catch (fetchErr) {
                console.warn(`Failed to ingest deck file: ${entry.file}`, fetchErr);
              }
            }
          })
        );

        this.manifestVersion = manifestVer;
        if (!this.currentDeckId) {
          this.currentDeckId = manifest.defaultDeckId || Object.keys(this.decks)[0];
        }
        this.saveState();
      }
    } catch (err) {
      console.warn("Manifest check failed; falling back to offline state.", err);
    }
  }

  saveState() {
    try {
      const payload = {
        manifestVersion: this.manifestVersion,
        currentDeckId: this.currentDeckId,
        activeMode: this.activeMode,
        decks: this.decks
      };
      localStorage.setItem(Store.STORAGE_KEY, JSON.stringify(payload));
      this.dispatchEvent(new CustomEvent("state-saved"));
    } catch (err) {
      console.error("Failed to commit state to localStorage:", err);
    }
  }

  getCurrentDeck() {
    return this.decks[this.currentDeckId] || null;
  }

  setDeck(deckId) {
    if (!this.decks[deckId]) return;
    this.currentDeckId = deckId;
    this.activeMode = this.decks[deckId].defaultMode || "standard";
    this.resetStats();
    this.selectAllUnitsForCurrentDeck();
    this.saveState();
    this.dispatchEvent(new CustomEvent("deck-changed", { detail: { deckId } }));
  }

  setMode(mode) {
    this.activeMode = mode;
    this.saveState();
    this.dispatchEvent(new CustomEvent("mode-changed", { detail: { mode } }));
  }

  /**
   * Builds an indexed map of Groups, Units, and constituent Character Tokens
   * Output structure: { [group: string]: { [unit: string]: Array<string> } }
   */
  getCategoryHierarchy() {
    const deck = this.getCurrentDeck();
    if (!deck || !Array.isArray(deck.cards)) return {};

    const hierarchy = {};

    for (const card of deck.cards) {
      const group = card.group || "General";
      const unit = card.unit || "General";

      if (!hierarchy[group]) {
        hierarchy[group] = {};
      }
      if (!hierarchy[group][unit]) {
        hierarchy[group][unit] = [];
      }

      // Collect prompt tokens for DJT visual preview pills
      if (card.prompt && !hierarchy[group][unit].includes(card.prompt)) {
        hierarchy[group][unit].push(card.prompt);
      }
    }

    return hierarchy;
  }

  selectAllUnitsForCurrentDeck() {
    this.selectedUnits.clear();
    const hierarchy = this.getCategoryHierarchy();
    for (const [group, units] of Object.entries(hierarchy)) {
      for (const unit of Object.keys(units)) {
        this.selectedUnits.add(`${group}::${unit}`);
      }
    }
    this.dispatchEvent(new CustomEvent("categories-changed"));
  }

  deselectAllUnits() {
    this.selectedUnits.clear();
    this.dispatchEvent(new CustomEvent("categories-changed"));
  }

  toggleUnit(group, unit, isSelected) {
    const key = `${group}::${unit}`;
    if (isSelected) {
      this.selectedUnits.add(key);
    } else {
      this.selectedUnits.delete(key);
    }
    this.dispatchEvent(new CustomEvent("categories-changed"));
  }

  getActivePool() {
    const deck = this.getCurrentDeck();
    if (!deck || !Array.isArray(deck.cards)) return [];

    return deck.cards.filter((card) => {
      const key = `${card.group || "General"}::${card.unit || "General"}`;
      return this.selectedUnits.has(key);
    });
  }

  recordResult(cardId, isCorrect) {
    this.stats.attempts++;
    if (isCorrect) {
      this.stats.correct++;
      this.stats.streak++;
    } else {
      this.stats.streak = 0;
    }

    const deck = this.getCurrentDeck();
    if (deck) {
      const card = deck.cards.find((c) => c.id === cardId);
      if (card) {
        if (isCorrect) {
          card.weight = Math.max(0.2, (card.weight || 1.0) * 0.7);
        } else {
          card.weight = (card.weight || 1.0) + 1.5;
        }
        this.saveState();
      }
    }

    this.dispatchEvent(new CustomEvent("stats-updated", { detail: { ...this.stats } }));
  }

  resetStats() {
    this.stats = { correct: 0, attempts: 0, streak: 0 };
    this.dispatchEvent(new CustomEvent("stats-updated", { detail: { ...this.stats } }));
  }

  appendCards(newCards) {
    const deck = this.getCurrentDeck();
    if (!deck) return;

    deck.cards.push(...newCards);
    this.selectAllUnitsForCurrentDeck();
    this.saveState();
    this.dispatchEvent(new CustomEvent("deck-updated"));
  }

  replaceDecks(newDecks) {
    this.decks = newDecks;
    const firstDeckId = Object.keys(this.decks)[0] || "";
    this.currentDeckId = firstDeckId;
    this.activeMode = this.decks[firstDeckId]?.defaultMode || "standard";
    this.resetStats();
    this.selectAllUnitsForCurrentDeck();
    this.saveState();
    this.dispatchEvent(new CustomEvent("deck-changed", { detail: { deckId: firstDeckId } }));
  }

  async resetToDefaults() {
    localStorage.removeItem(Store.STORAGE_KEY);
    this.decks = {};
    this.manifestVersion = 0;
    await this.syncWithManifest();
    this.resetStats();
    this.selectAllUnitsForCurrentDeck();
    this.dispatchEvent(new CustomEvent("deck-changed", { detail: { deckId: this.currentDeckId } }));
  }
}
