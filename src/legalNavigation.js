import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

export const LEGAL_URLS = Object.freeze({
  privacy: 'https://cornpiess.github.io/delete_photo/privacy.html',
  terms: 'https://cornpiess.github.io/delete_photo/terms.html',
});

export async function openLegalPage(type) {
  const url = LEGAL_URLS[type] || LEGAL_URLS.privacy;
  try {
    await WebBrowser.openBrowserAsync(url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      dismissButtonStyle: 'close',
      controlsColor: '#FF526F',
    });
    return true;
  } catch {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      return false;
    }
  }
}
