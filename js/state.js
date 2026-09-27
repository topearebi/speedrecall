/**
 * js/state.js - Reactive State Store & Manifest Ingestion Layer
 * Handles:
 *  - Dynamic asynchronous loading from data/manifest.json
 *  - Schema version migration (clearing stale stub caches)
 *  - Category hierarchy indexing with character tokens for visual previews
 *  - Spaced repetition weighting and local persistence
 */

export class Store extends EventTarget {
  static STORAGE_KEY = "speedrecall_state_v2";
  static MANIFEST_PATH = "./data/manifest.json";

  constructor() {
    super();
    this.decks = {};
    this.currentDeckId = "";
    this.activeMode = "standard";
    this.schemaVersion = 3;
    
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
   * Asynchronously bootstraps state: verifies versioning, ingests manifest if needed
   */
  async init() {
    const raw = localStorage.getItem(Store.STORAGE_KEY);
    let stateValid = false;

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.schemaVersion === this.schemaVersion && parsed.decks && Object.keys(parsed.decks).length > 0) {
          this.decks = parsed.decks;
          this.currentDeckId = parsed.currentDeckId || Object.keys(this.decks)[0];
          this.activeMode = parsed.activeMode || "standard";
          stateValid = true;
        }
      } catch (err) {
        console.warn("Storage corrupted or outdated. Reloading from manifest.", err);
      }
    }

    if (!stateValid) {
      await this.loadFromManifest();
    }

    this.selectAllUnitsForCurrentDeck();
    this.isInitialized = true;
    this.dispatchEvent(new CustomEvent("initialized"));
  }

  /**
   * Fetches data/manifest.json and loads all baseline JSON decks concurrently
   */
  async loadFromManifest() {
    try {
      const manifestRes = await fetch(Store.MANIFEST_PATH);
      if (!manifestRes.ok) throw new Error(`HTTP ${manifestRes.status} loading manifest`);
      const manifest = await manifestRes.json();

      const loadedDecks = {};

      await Promise.all(
        manifest.decks.map(async (entry) => {
          try {
            const deckRes = await fetch(entry.file);
            if (!deckRes.ok) throw new Error(`HTTP ${deckRes.status} loading ${entry.file}`);
            const deckData = await deckRes.json();

            loadedDecks[entry.id] = {
              name: deckData.name || entry.name,
              defaultMode: entry.defaultMode || "standard",
              cards: deckData.cards || []
            };
          } catch (fetchErr) {
            console.error(`Failed to ingest deck file: ${entry.file}`, fetchErr);
          }
        })
      );

      this.decks = loadedDecks;
      this.currentDeckId = manifest.defaultDeckId || Object.keys(this.decks)[0] || "";
      this.activeMode = this.decks[this.currentDeckId]?.defaultMode || "standard";
      this.saveState();
    } catch (err) {
      console.error("Critical failure during manifest ingestion:", err);
    }
  }

  saveState() {
    try {
      const payload = {
        schemaVersion: this.schemaVersion,
        currentDeckId: this.currentDeckId,
        activeMode: this.activeMode,
        decks: this.decks
      };
      localStorage.setItem(Store.STORAGE_KEY, JSON.stringify(payload));
      this.dispatchEvent(new CustomEvent("state-saved"));
    } catch (err) {
      console.error("Failed to write state to localStorage:", err);
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
   * Returns: { [group: string]: { [unit: string]: Array<string> } }
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

      // Collect prompt glyphs for DJT visual preview pills
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
    await this.loadFromManifest();
    this.resetStats();
    this.selectAllUnitsForCurrentDeck();
    this.dispatchEvent(new CustomEvent("deck-changed", { detail: { deckId: this.currentDeckId } }));
  }
}
