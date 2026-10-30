import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';

import zhHans from './locales/zh-Hans';
import zhHant from './locales/zh-Hant';
import en from './locales/en';
import es from './locales/es';
import ja from './locales/ja';
import ko from './locales/ko';

const LOCALES = {
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
  en,
  es,
  ja,
  ko,
};

const STORAGE_KEY = '@maoqiu_language';

// Detect system default language from device / Apple Store region settings
export function getSystemLocale() {
  try {
    const deviceLocales = Localization.getLocales();
    if (deviceLocales && deviceLocales.length > 0) {
      const primary = deviceLocales[0];
      const tag = (primary.languageTag || `${primary.languageCode}-${primary.regionCode}`).toLowerCase();
      const code = (primary.languageCode || '').toLowerCase();

      if (tag.startsWith('zh-hant') || tag.startsWith('zh-tw') || tag.startsWith('zh-hk') || tag.startsWith('zh-mo')) {
        return 'zh-Hant';
      }
      if (tag.startsWith('zh-hans') || tag.startsWith('zh-cn') || tag.startsWith('zh-sg') || code === 'zh') {
        return 'zh-Hans';
      }
      if (code === 'ja') return 'ja';
      if (code === 'ko') return 'ko';
      if (code === 'es') return 'es';
      if (code === 'en') return 'en';
    }
  } catch (e) {
    console.warn('Locale detection failed:', e);
  }
  return 'en'; // fallback for international users
}

const I18nContext = createContext({
  languageSetting: 'auto', // 'auto' | 'zh-Hans' | 'zh-Hant' | 'en' | 'es' | 'ja' | 'ko'
  currentLocale: 'en',
  setLanguage: () => {},
  t: (key, params) => key,
  formatLocalizedDate: (dateInput) => '',
});

export function I18nProvider({ children }) {
  const [languageSetting, setLanguageSettingState] = useState('auto');
  const [currentLocale, setCurrentLocale] = useState(getSystemLocale());

  useEffect(() => {
    // Load saved language preference
    AsyncStorage.getItem(STORAGE_KEY)
      .then((saved) => {
        if (saved) {
          setLanguageSettingState(saved);
          if (saved === 'auto') {
            setCurrentLocale(getSystemLocale());
          } else if (LOCALES[saved]) {
            setCurrentLocale(saved);
          }
        }
      })
      .catch(() => {});
  }, []);

  const setLanguage = async (newSetting) => {
    setLanguageSettingState(newSetting);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, newSetting);
    } catch (e) {}

    if (newSetting === 'auto') {
      setCurrentLocale(getSystemLocale());
    } else if (LOCALES[newSetting]) {
      setCurrentLocale(newSetting);
    }
  };

  const t = (keyPath, params) => {
    const dict = LOCALES[currentLocale] || LOCALES['en'];
    const fallbackDict = LOCALES['en'];

    const keys = keyPath.split('.');
    let val = dict;
    let fallbackVal = fallbackDict;

    for (const k of keys) {
      val = val ? val[k] : undefined;
      fallbackVal = fallbackVal ? fallbackVal[k] : undefined;
    }

    let result = typeof val === 'string' ? val : (typeof fallbackVal === 'string' ? fallbackVal : keyPath);

    if (params && typeof params === 'object') {
      Object.keys(params).forEach((pKey) => {
        result = result.replace(new RegExp(`\\{${pKey}\\}`, 'g'), String(params[pKey]));
      });
    }

    return result;
  };

  const formatLocalizedDate = (dateInput, opts) => {
    const { withWeekday = true, withTime = true } = opts || {};
    if (!dateInput) return '';
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);

    const year = d.getFullYear();
    const month = d.getMonth() + 1;
    const date = d.getDate();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');

    const dayOfWeekIndex = d.getDay();
    const daysEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const daysZh = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const daysJa = ['日', '月', '火', '水', '木', '金', '土'];
    const daysKo = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
    const daysEs = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

    const monthsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthsEs = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

    const time = withTime ? ` ${hours}:${minutes}` : '';
    const weekday = withWeekday;

    switch (currentLocale) {
      case 'zh-Hans':
      case 'zh-Hant':
        return `${year}年${month}月${date}日${weekday ? ` ${daysZh[dayOfWeekIndex]}` : ''}${time}`;
      case 'ja':
        return `${year}年${month}月${date}日${weekday ? ` (${daysJa[dayOfWeekIndex]})` : ''}${time}`;
      case 'ko':
        return `${year}년 ${month}월 ${date}일${weekday ? ` ${daysKo[dayOfWeekIndex]}` : ''}${time}`;
      case 'es':
        return `${weekday ? `${daysEs[dayOfWeekIndex]}, ` : ''}${date} de ${monthsEs[month - 1]} de ${year}${time}`;
      case 'en':
      default:
        return `${weekday ? `${daysEn[dayOfWeekIndex]}, ` : ''}${monthsEn[month - 1]} ${date}, ${year}${time}`;
    }
  };

  return (
    <I18nContext.Provider
      value={{
        languageSetting,
        currentLocale,
        setLanguage,
        t,
        formatLocalizedDate,
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
