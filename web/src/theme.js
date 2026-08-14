// 主题管理：4 套主题 + localStorage 持久化 + highlight.js 代码高亮样式联动
import hljsDarkUrl from 'highlight.js/styles/github-dark.css?url';
import hljsLightUrl from 'highlight.js/styles/github.css?url';

export const THEMES = [
  { id: 'day',   name: '白天', icon: 'bi-sun',          dark: false },
  { id: 'night', name: '黑夜', icon: 'bi-moon-stars',   dark: true },
  { id: 'dawn',  name: '清晨', icon: 'bi-sunrise',      dark: false },
  { id: 'dusk',  name: '黄昏', icon: 'bi-sunset',       dark: true },
];

const STORAGE_KEY = 'app-theme';
const DEFAULT_THEME = 'night';

let hljsLink = null;

export function currentTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  return THEMES.some(t => t.id === saved) ? saved : DEFAULT_THEME;
}

export function applyTheme(id) {
  const theme = THEMES.find(t => t.id === id) || THEMES.find(t => t.id === DEFAULT_THEME);
  const root = document.documentElement;
  root.setAttribute('data-theme', theme.id);
  root.setAttribute('data-bs-theme', theme.dark ? 'dark' : 'light');
  localStorage.setItem(STORAGE_KEY, theme.id);

  // 联动切换 highlight.js 代码高亮配色（深色主题用 github-dark，浅色用 github）
  if (!hljsLink) {
    hljsLink = document.createElement('link');
    hljsLink.rel = 'stylesheet';
    document.head.appendChild(hljsLink);
  }
  hljsLink.href = theme.dark ? hljsDarkUrl : hljsLightUrl;
}
