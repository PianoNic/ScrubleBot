// Wordlist loading. Source: skribbliohints (per-language JSON, map of
// word -> { word, picked, successRate }). `picked` = popularity, `successRate`
// = fraction of rounds it was guessed — both used to rank candidates.

const LANG_FILE = {
  0: 'English', 7: 'French', // skribbl lang indices we have lists for
  // German/Korean/Spanish files also exist in the repo; add indices as needed.
};

/**
 * @param {number} lang skribbl language index
 * @returns {Promise<Array<{word:string, key:string, picked:number, sr:number}>>}
 *   entries pre-lowercased into `key` for matching.
 */
export async function loadWordlist(lang = 0) {
  const name = LANG_FILE[lang] || 'English';
  const url = new URL(`../data/wordlists/${name}.json`, import.meta.url);
  const raw = await Bun.file(url).json();
  return Object.keys(raw).map((w) => ({
    word: w,
    key: w.toLowerCase(),
    picked: raw[w]?.picked ?? 0,
    sr: raw[w]?.successRate ?? 0,
  }));
}
