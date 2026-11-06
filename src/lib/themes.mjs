// Reading themes for the Qur'an page: the paper, the ink and the colours of the reading marks together,
// so each reader can pick what is easiest on their eyes. The CSS for each theme is in global.css
// (html[data-paper="…"]); this list feeds the picker in the Quran menu (QuranBar).
// [key, name, paper, ink, what it is for, names of the marks: read, mistake, hint]
export const THEMES = [
  ['cream', 'Warm cream', '#FFFBF0', '#1A1A17', 'The printed mushaf look', ['Green', 'Red', 'Gold']],
  ['white', 'Bright white', '#FFFFFF', '#111111', 'Crisp and clear in daylight', ['Green', 'Red', 'Gold']],
  ['sepia', 'Low-glare sepia', '#F0E0C0', '#2A1C0C', 'Softer on tired eyes and long sessions', ['Green', 'Red', 'Gold']],
  ['green', 'Soft green', '#E6F1E8', '#12241A', 'Calm and restful', ['Green', 'Red', 'Gold']],
  ['blue', 'Calm blue', '#E4EEF8', '#0F1E33', 'Helps readers who find white pages glare or the letters swim', ['Green', 'Red', 'Gold']],
  ['contrast', 'High contrast', '#FFFFFF', '#000000', 'Black on white with bolder letters, for low vision', ['Green', 'Red', 'Brown']],
  ['yellow', 'Yellow on black', '#000000', '#FFE95C', 'Strongest contrast, for low vision and dark rooms', ['Cyan', 'Pink', 'White']],
  ['cb', 'Colour-blind safe', '#FFFBF0', '#1A1A17', 'Blue and orange marks instead of green and red', ['Blue', 'Orange', 'Purple']],
  ['night', 'Night', '#14201A', '#EEE7D4', 'Dark page for evenings', ['Green', 'Red', 'Gold']],
];
export const THEME_KEYS = THEMES.map(([k]) => k);
