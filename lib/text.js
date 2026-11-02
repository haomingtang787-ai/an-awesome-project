/**
 * 诗句与检索词的共用整理。只去掉标点和空白，不改字。
 */

/**
 * 抽出汉字。平水韵与粘对都按字，不把标点算进位置。
 * @param {unknown} text
 * @returns {string[]}
 */
export function hanzi(text) {
  return [...String(text ?? "")].filter((ch) => /\p{Script=Han}/u.test(ch));
}

/**
 * 作者、诗题、典故名的比对键。
 * @param {unknown} text
 * @returns {string}
 */
export function normKey(text) {
  return String(text ?? "")
    .replace(/[《》〈〉「」『』“”‘’"'·・\s，。！？、；：,.;!?()（）【】\-—]/g, "")
    .trim();
}
