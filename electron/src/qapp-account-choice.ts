import i18next from 'i18next';

export type RunningHubAccount = {
  port: number;
  instance: number;
  name?: string;
  address?: string;
  avatarUrl?: string;
};

const translations: Record<
  string,
  {
    choose: string;
    chooseHub: string;
    newHub: string;
    anotherAccount: string;
    cancel: string;
    hub: string;
  }
> = {
  en: {
    choose: 'Open {{app}} with which account?',
    chooseHub: 'Which Hub would you like to open?',
    newHub: 'Open another Hub',
    anotherAccount: 'Use another account',
    cancel: 'Cancel',
    hub: 'Hub {{number}}',
  },
  ar: {
    choose: 'بأي حساب تريد فتح {{app}}؟',
    chooseHub: 'أي نسخة من Hub تريد فتحها؟',
    newHub: 'فتح نسخة أخرى من Hub',
    anotherAccount: 'استخدام حساب آخر',
    cancel: 'إلغاء',
    hub: 'Hub {{number}}',
  },
  de: {
    choose: 'Mit welchem Konto {{app}} öffnen?',
    chooseHub: 'Welchen Hub möchten Sie öffnen?',
    newHub: 'Weiteren Hub öffnen',
    anotherAccount: 'Anderes Konto verwenden',
    cancel: 'Abbrechen',
    hub: 'Hub {{number}}',
  },
  es: {
    choose: '¿Con qué cuenta quieres abrir {{app}}?',
    chooseHub: '¿Qué Hub quieres abrir?',
    newHub: 'Abrir otro Hub',
    anotherAccount: 'Usar otra cuenta',
    cancel: 'Cancelar',
    hub: 'Hub {{number}}',
  },
  et: {
    choose: 'Millise kontoga avada {{app}}?',
    chooseHub: 'Millise Hubi soovid avada?',
    newHub: 'Ava veel üks Hub',
    anotherAccount: 'Kasuta teist kontot',
    cancel: 'Tühista',
    hub: 'Hub {{number}}',
  },
  fi: {
    choose: 'Millä tilillä {{app}} avataan?',
    chooseHub: 'Minkä Hubin haluat avata?',
    newHub: 'Avaa toinen Hub',
    anotherAccount: 'Käytä toista tiliä',
    cancel: 'Peruuta',
    hub: 'Hub {{number}}',
  },
  fr: {
    choose: 'Avec quel compte ouvrir {{app}} ?',
    chooseHub: 'Quel Hub souhaitez-vous ouvrir ?',
    newHub: 'Ouvrir un autre Hub',
    anotherAccount: 'Utiliser un autre compte',
    cancel: 'Annuler',
    hub: 'Hub {{number}}',
  },
  it: {
    choose: 'Con quale account aprire {{app}}?',
    chooseHub: 'Quale Hub vuoi aprire?',
    newHub: 'Apri un altro Hub',
    anotherAccount: 'Usa un altro account',
    cancel: 'Annulla',
    hub: 'Hub {{number}}',
  },
  ja: {
    choose: 'どのアカウントで{{app}}を開きますか？',
    chooseHub: 'どのHubを開きますか？',
    newHub: '別のHubを開く',
    anotherAccount: '別のアカウントを使う',
    cancel: 'キャンセル',
    hub: 'Hub {{number}}',
  },
  pt: {
    choose: 'Com qual conta abrir {{app}}?',
    chooseHub: 'Qual Hub você deseja abrir?',
    newHub: 'Abrir outro Hub',
    anotherAccount: 'Usar outra conta',
    cancel: 'Cancelar',
    hub: 'Hub {{number}}',
  },
  ru: {
    choose: 'Через какую учётную запись открыть {{app}}?',
    chooseHub: 'Какой Hub открыть?',
    newHub: 'Открыть ещё один Hub',
    anotherAccount: 'Использовать другую учётную запись',
    cancel: 'Отмена',
    hub: 'Hub {{number}}',
  },
  zh: {
    choose: '使用哪个账户打开 {{app}}？',
    chooseHub: '要打开哪个 Hub？',
    newHub: '打开另一个 Hub',
    anotherAccount: '使用其他账户',
    cancel: '取消',
    hub: 'Hub {{number}}',
  },
};

export async function qAppAccountChoiceText(locale: string, appName?: string) {
  const language = locale.split('-')[0].toLowerCase();
  const i18n = i18next.createInstance();
  await i18n.init({
    resources: Object.fromEntries(
      Object.entries(translations).map(([lang, values]) => [
        lang,
        { translation: values },
      ])
    ),
    lng: translations[language] ? language : 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
  return {
    language,
    message: appName ? i18n.t('choose', { app: appName }) : i18n.t('chooseHub'),
    newInstance: i18n.t(appName ? 'anotherAccount' : 'newHub'),
    newHub: i18n.t('newHub'),
    cancel: i18n.t('cancel'),
    hubLabel: (account: RunningHubAccount) =>
      i18n.t('hub', { number: account.instance + 1 }),
    accountLabel: (account: RunningHubAccount) => {
      const hub = i18n.t('hub', { number: account.instance + 1 });
      const name = account.name?.trim() || hub;
      const address = account.address?.trim();
      return [name, address, name === hub ? undefined : hub]
        .filter(Boolean)
        .join(' · ');
    },
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function renderQAppAccountChoiceHtml(
  labels: Awaited<ReturnType<typeof qAppAccountChoiceText>>,
  accounts: RunningHubAccount[]
): string {
  const rows = accounts
    .map((account, index) => {
      const hub = labels.hubLabel(account);
      const name = account.name?.trim() || hub;
      const address = account.address?.trim() || '';
      const initial = Array.from(name)[0]?.toLocaleUpperCase() || 'Q';
      return `<button class="account" type="button" data-choice="${index}" aria-label="${escapeHtml(labels.accountLabel(account))}">
        <span class="avatar" aria-hidden="true">${escapeHtml(initial)}${account.avatarUrl ? `<img src="${escapeHtml(account.avatarUrl)}" alt="" />` : ''}</span>
        <span class="account-details">
          <span class="account-name">${escapeHtml(name)}</span>
          ${address ? `<span class="address">${escapeHtml(address)}</span>` : ''}
        </span>
        ${name === hub ? '' : `<span class="instance">${escapeHtml(hub)}</span>`}
        <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
      </button>`;
    })
    .join('');

  return `<!doctype html>
<html lang="${escapeHtml(labels.language)}"${labels.language === 'ar' ? ' dir="rtl"' : ''}><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Qortal Hub</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; }
  body { background: #151922; color: #f3f6fc; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  button { font: inherit; cursor: pointer; }
  .shell { display: flex; flex-direction: column; height: 100%; border: 1px solid #343c49; }
  .header { display: flex; align-items: center; gap: 11px; padding: 19px 22px 0; -webkit-app-region: drag; }
  .brand { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: 9px; color: #a9cdff; background: #243b61; border: 1px solid #486b9e; }
  .brand svg { width: 21px; height: 21px; }
  .brand-name { flex: 1; font-size: 13px; font-weight: 700; letter-spacing: .02em; }
  .close { -webkit-app-region: no-drag; width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: #abb5c5; font-size: 20px; line-height: 1; }
  .close:hover { color: #fff; background: #303845; }
  h1 { margin: 23px 22px 18px; font-size: 20px; line-height: 1.3; font-weight: 650; letter-spacing: -.02em; }
  .accounts { display: flex; flex: 1; flex-direction: column; gap: 9px; min-height: 0; overflow: auto; padding: 0 22px 18px; }
  .account { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 67px; padding: 11px 13px; text-align: left; color: inherit; background: #202733; border: 1px solid #394454; border-radius: 11px; transition: background .14s ease, border-color .14s ease, box-shadow .14s ease; }
  .account:hover, .account:focus-visible { background: #27354a; border-color: #84aff0; box-shadow: 0 0 0 2px rgba(132,175,240,.16); outline: 0; }
  .new-account { margin-top: 4px; color: #cfe5ff; background: #1d304a; border-color: #547db4; }
  .new-account .avatar { background: #245485; font-size: 25px; font-weight: 400; }
  .avatar { position: relative; display: grid; place-items: center; width: 39px; height: 39px; flex: none; overflow: hidden; border-radius: 50%; background: #33527c; color: #dceaff; font-size: 17px; font-weight: 700; }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; }
  .avatar img.loaded { opacity: 1; }
  .account-details { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
  .account-name { overflow: hidden; font-size: 14px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .address { overflow: hidden; color: #aab6c8; font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
  .instance { flex: none; padding: 5px 7px; border: 1px solid #465367; border-radius: 6px; color: #bdc8d8; font-size: 11px; white-space: nowrap; }
  .chevron { width: 16px; height: 16px; flex: none; fill: none; stroke: #a8b7cb; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .footer { display: flex; justify-content: flex-end; padding: 12px 22px 18px; border-top: 1px solid #2d3542; }
  .cancel { min-width: 80px; height: 32px; padding: 0 13px; border: 1px solid #465367; border-radius: 8px; color: #d4dce8; background: #222a36; }
  .cancel:hover, .cancel:focus-visible { border-color: #84aff0; background: #2a3545; outline: 0; }
</style></head><body>
<main class="shell">
  <div class="header"><span class="brand" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 2 21 7v10l-9 5-9-5V7l9-5Z" stroke="currentColor" stroke-width="2"/><path d="m8 12 3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="brand-name">Qortal Hub</span><button class="close" type="button" data-choice="-1" aria-label="${escapeHtml(labels.cancel)}">×</button></div>
  <h1>${escapeHtml(labels.message)}</h1>
  <div class="accounts">${rows}<button class="account new-account" type="button" data-choice="new" aria-label="${escapeHtml(labels.newInstance)}"><span class="avatar" aria-hidden="true">+</span><span class="account-details"><span class="account-name">${escapeHtml(labels.newInstance)}</span></span><svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button></div>
  <div class="footer"><button class="cancel" type="button" data-choice="-1">${escapeHtml(labels.cancel)}</button></div>
</main></body></html>`;
}
