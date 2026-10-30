export const colors = {
  bg: '#0D0E12',
  card: '#16171D',
  overlay: 'rgba(0, 0, 0, 0.40)',
  primary: '#FFFFFF',
  primarySoft: '#FFFFFF',
  danger: '#EF4444',
  success: '#10B981',
  text: '#FFFFFF',
  textMuted: '#9CA3AF',
  white: '#FFFFFF',

  // 猫咪理毛与毛球主题专属暖柔色调
  warmWhite: '#FFFDF9',
  milkWhite: '#F8F9FA',
  catCream: '#FFF5EA',
  catPaw: '#FF758F',
  catGold: '#FFE3A8',

  fav: '#FFFFFF',
  glassBg: 'rgba(255, 255, 255, 0.16)',
  glassBorder: 'rgba(255, 255, 255, 0.38)',
  glassBorderStrong: 'rgba(255, 255, 255, 0.55)',
  glassHighlight: 'rgba(255, 255, 255, 0.50)',
  glassShadow: 'rgba(0, 0, 0, 0.30)',
  glassDanger: 'rgba(239, 68, 68, 0.75)',
};

export const glass = {
  shadow: {
    shadowColor: 'rgba(0,0,0,0.40)',
    shadowOpacity: 1,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  glow: {
    shadowColor: 'rgba(255,255,255,0.22)',
    shadowOpacity: 1,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

/** Human-readable size: always MB, switch to GB once >= 1 GB. */
export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 MB';
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
