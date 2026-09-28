import { create } from 'zustand';
import { persist } from 'zustand/middleware';

function readStoredToken() {
  try {
    return localStorage.getItem('panel_token');
  } catch (e) {
    return null;
  }
}

export const useAuthStore = create(
  persist(
    (set) => ({
      token: readStoredToken(),
      user: null,
      setAuth: (token, user) => {
        try {
          localStorage.setItem('panel_token', token);
        } catch (e) {
          // 隐私模式等场景下写入失败可忽略
        }
        set({ token, user });
      },
      clearAuth: () => {
        try {
          localStorage.removeItem('panel_token');
          localStorage.removeItem('panel_auth');
        } catch (e) {
          // 隐私模式等场景下写入失败可忽略
        }
        set({ token: null, user: null });
        (async () => {
          try {
            const { logout } = await import('@/api/auth');
            await logout();
          } catch (e) {
            // ignore
          }
        })();
      },
    }),
    {
      name: 'panel_auth',
      partialize: (state) => ({ user: state.user }),
    }
  )
);

export const useServiceStore = create((set) => ({
  refreshKey: 0,
  triggerRefresh: () => set((state) => ({ refreshKey: state.refreshKey + 1 })),
}));

export const useUIStore = create((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}));

// ---- 主题颜色 ----
// 色值取自 https://script.myweb3.club/theme-colors.html
// name/desc 字段已移除，改用 i18n t('theme.{id}') / t('theme.{id}Desc') 动态翻译
export const THEMES = [
  { id: 'cyan', rgb: [34, 211, 238] },
  { id: 'mint-blue', rgb: [195, 224, 231] },
  { id: 'deep-blue', rgb: [40, 87, 147] },
  { id: 'mint-green', rgb: [168, 201, 200] },
  { id: 'gray-blue', rgb: [79, 93, 122] },
  { id: 'sage-green', rgb: [153, 188, 172] },
  { id: 'rose-pink', rgb: [164, 86, 104] },
  { id: 'warm-camel', rgb: [167, 138, 115] },
  { id: 'autumn-gold', rgb: [198, 163, 72] },
  { id: 'steel-blue', rgb: [168, 195, 214] },
  { id: 'classic-red', rgb: [255, 36, 66] },
  { id: 'indigo', rgb: [99, 102, 241] },
  { id: 'violet', rgb: [139, 92, 246] },
  { id: 'teal', rgb: [20, 184, 166] },
  { id: 'coral', rgb: [244, 132, 95] },
  { id: 'slate', rgb: [100, 116, 139] },
];

const THEME_KEY = 'panel_theme_id';

// 每个色阶的固定亮度（贴近 Tailwind cyan 的明暗梯度，保证暗色背景上的可读性）
const SHADE_LIGHTNESS = {
  50: 97, 100: 93, 200: 88, 300: 78, 400: 62, 500: 46,
  600: 38, 700: 31, 800: 25, 900: 20, 950: 14,
};

function rgbToHsl([r, g, b]) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255;
  const max = Math.max(rn, gn, bn); const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l * 100];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h * 360, s * 100, l * 100];
}

function hslToRgb(h, s, l) {
  const sn = s / 100; const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = ln - c / 2;
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((v) => Math.round((v + m) * 255));
}

// 由主题基色推导整套色阶：保留色相与饱和度，仅按固定亮度阶梯铺开
function buildAccentShades(baseRgb) {
  const [h, s] = rgbToHsl(baseRgb);
  const sat = Math.min(Math.max(s, 24), 85);
  const shades = {};
  Object.entries(SHADE_LIGHTNESS).forEach(([shade, l]) => {
    shades[shade] = hslToRgb(h, sat, l);
  });
  return shades;
}

function findTheme(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

export function applyTheme(id) {
  const theme = findTheme(id);
  const shades = buildAccentShades(theme.rgb);
  const root = document.documentElement;
  Object.entries(shades).forEach(([shade, [r, g, b]]) => {
    root.style.setProperty(`--accent-${shade}`, `${r} ${g} ${b}`);
  });
  root.dataset.theme = theme.id;
}

function readStoredTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || THEMES[0].id;
  } catch (e) {
    return THEMES[0].id;
  }
}

export const useThemeStore = create((set) => ({
  themeId: readStoredTheme(),
  setTheme: (id) => {
    applyTheme(id);
    try {
      localStorage.setItem(THEME_KEY, id);
    } catch (e) {
      // 隐私模式等场景下写入失败可忽略，仅本次会话生效
    }
    set({ themeId: id });
  },
}));

// 首屏渲染前应用已保存的主题，避免闪一下默认色
export function initTheme() {
  applyTheme(readStoredTheme());
}