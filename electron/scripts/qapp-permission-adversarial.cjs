// Run after `npx tsc` with:
// env -u ELECTRON_RUN_AS_NODE electron ./scripts/qapp-permission-adversarial.cjs
const { app, BrowserWindow, ipcMain, webContents } = require('electron');
const http = require('http');
const { join } = require('path');
const { pathToFileURL } = require('url');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { QAppPermissionBroker } = require('../build/src/qapp-permission-broker.js');

const hostPreload = join(__dirname, '..', 'build', 'src', 'qapp-host-preload.js');
const guestPreload = join(__dirname, '..', 'build', 'src', 'qapp-guest-preload.js');
const token = `adversarial-${process.pid}`;
const partition = `qapp-adversarial-${process.pid}`;
const userData = mkdtempSync(join(tmpdir(), 'qapp-permission-'));
app.setPath('userData', userData);
app.on('quit', () => rmSync(userData, { recursive: true, force: true }));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

let server;
let host;
const timeout = setTimeout(() => {
  process.stderr.write('Adversarial permission test timed out\n');
  app.exit(1);
}, 15000);

app.whenReady().then(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Malicious Q-App</title><body>Q-App</body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const guestUrl = `http://127.0.0.1:${server.address().port}/render/APP/attack`;

  host = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: hostPreload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  host.webContents.on('preload-error', (_event, path, error) => {
    throw new Error(`Host preload ${path}: ${error}`);
  });
  const broker = new QAppPermissionBroker((hostId, prompt) => {
    assert(hostId === host.webContents.id, 'Prompt routed to wrong host');
    host.webContents.send('qappHost:permissionPrompt', prompt);
  });
  let responseCount = 0;
  ipcMain.on('qappHost:permissionRespond', (event, promptId, answer) => {
    if (broker.respond(
      promptId,
      event.sender.id,
      event.senderFrame === event.sender.mainFrame &&
        event.sender.id === host.webContents.id,
      answer
    )) responseCount++;
  });
  ipcMain.handle('qappGuest:hello', (event, suppliedToken) => {
    assert(event.sender.getType() === 'webview' && suppliedToken === token,
      'Guest identity mismatch');
    return true;
  });
  host.webContents.on('will-attach-webview', (_event, prefs) => {
    prefs.preload = guestPreload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.additionalArguments = [`--qapp-guest-token=${token}`];
  });
  host.webContents.on('did-attach-webview', (_event, guestContents) => {
    guestContents.on('preload-error', (_e, path, error) => {
      throw new Error(`Guest preload ${path}: ${error}`);
    });
  });

  const html = `<button id="approve" onclick="window.electronAPI.respondToQAppHostPermission(window.promptId, {accepted:true})">Approve</button>
    <webview id="guest" partition="${partition}" preload="${pathToFileURL(guestPreload)}?authorization=probe" src="${guestUrl}" style="display:flex;width:400px;height:300px"></webview>
    <script>window.electronAPI.onQAppHostPermissionPrompt(prompt => {
      window.promptId = prompt.promptId;
      document.body.dataset.promptShown = 'true';
    });</script>`;
  await host.loadURL(`data:text/html,${encodeURIComponent(html)}`);

  let guestId;
  for (let i = 0; i < 100; i++) {
    try {
      guestId = await host.webContents.executeJavaScript(
        "document.getElementById('guest').getWebContentsId?.()"
      );
    } catch {
      // The host or webview can still be finishing its first navigation.
    }
    if (guestId && webContents.fromId(guestId)?.getURL() === guestUrl) break;
    await delay(25);
  }
  const guest = webContents.fromId(guestId);
  assert(guest?.getURL() === guestUrl, 'Guest did not load');

  let settled = false;
  const permission = broker.request(host.webContents.id, 'Attack App', {});
  permission.then(() => { settled = true; });
  for (let i = 0; i < 40; i++) {
    if (await host.webContents.executeJavaScript(
      "document.body.dataset.promptShown === 'true'"
    )) break;
    await delay(25);
  }
  const promptId = await host.webContents.executeJavaScript('window.promptId');
  assert(typeof promptId === 'string', 'Host prompt was not shown');

  // Give the attacker the prompt ID. Isolation must hold even with that secret known.
  const attack = await guest.executeJavaScript(`(() => {
    const result = { topIsSelf: top === window, parentIsSelf: parent === window,
      electronAPI: typeof window.electronAPI, require: typeof window.require };
    try { parent.document.getElementById('approve').click(); result.parentClick = true; }
    catch (error) { result.parentClick = false; }
    try { top.electronAPI.respondToQAppHostPermission(${JSON.stringify(promptId)}, {accepted:true}); result.topApi = true; }
    catch (error) { result.topApi = false; }
    try { require('electron').ipcRenderer.send('qappHost:permissionRespond', ${JSON.stringify(promptId)}, {accepted:true}); result.rawIpc = true; }
    catch (error) { result.rawIpc = false; }
    parent.postMessage({channel:'qappHost:permissionRespond',promptId:${JSON.stringify(promptId)},answer:{accepted:true}}, '*');
    window.postMessage({channel:'qappHost:permissionRespond',promptId:${JSON.stringify(promptId)},answer:{accepted:true}}, '*');
    return result;
  })()`);
  await delay(300);
  assert(attack.topIsSelf && attack.parentIsSelf, 'Guest can reach host window');
  assert(attack.electronAPI === 'undefined' && attack.require === 'undefined',
    'Guest gained host bridge or Node API');
  assert(!attack.parentClick && !attack.topApi && !attack.rawIpc,
    'Guest executed a direct approval attempt');
  assert(!settled && responseCount === 0,
    'Guest approved permission using a forged UI message');
  assert(!broker.respond(promptId, guest.id, true, {accepted:true}),
    'Broker accepted a guest response');
  assert(!broker.respond(promptId, host.webContents.id, false, {accepted:true}),
    'Broker accepted a subframe response');
  assert(!settled && responseCount === 0,
    'Forged sender resolved permission');

  await host.webContents.executeJavaScript("document.getElementById('approve').click()");
  const answer = await permission;
  assert(answer.accepted && responseCount === 1,
    'Legitimate host approval failed');
  process.stdout.write(`PASS: guest DOM/API/IPC/message attacks blocked; forged sender blocked; host approval succeeded. ${JSON.stringify(attack)}\n`);
  clearTimeout(timeout);
  host.destroy();
  server.close();
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  clearTimeout(timeout);
  host?.destroy();
  server?.close();
  app.exit(1);
});
