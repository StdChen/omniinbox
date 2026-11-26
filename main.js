const obsidian = require('obsidian');

const DEFAULT_SETTINGS = {
  bindCode: '',
  bound: false,
  boundAt: 0,
  deviceName: 'Obsidian',
  serverUrl: 'https://dav.jianguoyun.com/dav/',
  remoteDir: 'obsidian-omniinbox',
  user: '',
  pass: '',
  notePath: '日记/随记.md',
  ideaPath: '领域21/灵感收集箱.md',
  memoPath: '日记/备忘录.md',
  thinoDir: '日记',
  todoPath: '日记/{Y}/每日待办.md',
  intervalMin: 1,
  statusBar: true,
  lastSync: 0,
  pendingNext: []
};

const ID_RE = /^(?:art|note|img|wx)?\d{14}-[0-9]+-[a-z0-9]+$/;

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function two(n) { return pad(n); }
function dateObj(ms) { return new Date(ms); }
function stampText(ms) {
  const d = dateObj(ms);
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate())
    + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
}
function dateText(ms) {
  const d = dateObj(ms);
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
}
function hmText(ms) {
  const d = dateObj(ms);
  return two(d.getHours()) + ':' + two(d.getMinutes());
}
function markCore(id) { return '⟦wx:' + id + '⟧'; }
function mark(id) { return '%%' + markCore(id) + '%%'; }

function captureText(s) {
  const lines = String(s == null ? '' : s).replace(/\r/g, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/[ \t]+$/, '');
  return lines.join('\n');
}

function mdOutline(text, base) {
  const out = [];
  String(text == null ? '' : text).replace(/\r/g, '').split('\n').forEach(raw => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) return;
    const lead = (line.match(/^[\t ]*/) || [''])[0];
    let lv = 0;
    for (let i = 0; i < lead.length; i++) if (lead.charAt(i) === '\t') lv++;
    lv += Math.floor(lead.replace(/\t/g, '').length / 2);
    let body = line.slice(lead.length).replace(/^(?:[-*+]|\d+[.)])\s+/, '');
    let task = '';
    const tm = body.match(/^\[([ xX-])\]\s+(.+)$/);
    if (tm) { task = '[' + tm[1] + '] '; body = tm[2]; }
    const h = body.match(/^#{1,6}\s+(.+)$/);
    if (h) body = '**' + h[1].trim() + '**';
    if (!body.trim()) return;
    out.push('\t'.repeat(base + Math.min(lv, 6)) + '- ' + task + body.trim());
  });
  return out;
}

function parseHrefs(xml) {
  const out = [];
  const re = /<(?:[A-Za-z0-9_-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?href>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim());
  return out;
}

module.exports = class OmniInbox extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();
    this.syncing = false;
    this.seen = new Set();

    if (this.settings.statusBar) {
      this.statusEl = this.addStatusBarItem();
      this.updateStatus();
    }

    this.addCommand({
      id: 'sync-now',
      name: '立即同步',
      callback: () => this.sync()
    });

    this.addCommand({
      id: 'process-due-todos',
      name: '处理明日待办',
      callback: () => this.processDue()
    });

    this.addSettingTab(new SettingTab(this.app, this));

    this.timer = setInterval(() => {
      if (this.settings.bound && this.settings.intervalMin > 0) this.sync();
    }, Math.max(1, this.settings.intervalMin || 1) * 60 * 1000);

    setTimeout(() => this.processDue().catch(() => {}), 1500);
    if (this.settings.bound) setTimeout(() => this.sync(), 3000);
  }

  onunload() {
    if (this.timer) clearInterval(this.timer);
  }

  updateStatus() {
    if (!this.statusEl) return;
    const t = this.settings.lastSync;
    this.statusEl.setText(t ? ('微信同步 · ' + stampText(t)) : '微信同步 · 就绪');
  }

  dueDate(item) {
    const s = String((item && item.dueDate) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
    return Date.parse(s + 'T00:00:00');
  }

  async processDue() {
    if (this.processingDue) return;
    this.processingDue = true;
    try {
      const today = dateText(Date.now());
      const pending = Array.isArray(this.settings.pendingNext) ? this.settings.pendingNext : [];
      const due = pending.filter(x => String((x && x.dueDate) || '') <= today);
      if (!due.length) return;
      let changed = false;
      for (const raw of due) {
        const dueMs = this.dueDate(raw);
        if (!Number.isFinite(dueMs)) { changed = true; continue; }
        const item = Object.assign({}, raw, { type: 'todo', createdAt: dueMs });
        if (!(await this.alreadyWritten(item))) {
          const target = this.legacyTarget(item);
          if (target) {
            await this.appendText(target, this.legacyEntry(item), this.headFor('todo'));
            changed = true;
          }
        } else {
          changed = true;
        }
      }
      if (changed) {
        this.settings.pendingNext = pending.filter(x =>
          String((x && x.dueDate) || '') > today && Number.isFinite(this.dueDate(x))
        );
        await this.saveSettings();
      }
    } finally {
      this.processingDue = false;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.pendingNext)) this.settings.pendingNext = [];
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  auth() {
    return 'Basic ' + Buffer.from(this.settings.user + ':' + this.settings.pass, 'utf8').toString('base64');
  }

  davBase() {
    return String(this.settings.serverUrl || '').replace(/\/+$/, '')
      + '/' + String(this.settings.remoteDir || 'obsidian-omniinbox').replace(/^\/+|\/+$/g, '') + '/';
  }

  async davRequest(url, method, body, extra) {
    const headers = Object.assign({ Authorization: this.auth() }, extra || {});
    const opt = { method: method || 'GET', headers: headers, throw: false };
    if (body != null) opt.body = body;
    const res = await obsidian.requestUrl({ url: url, method: opt.method, headers: headers, body: opt.body, throw: false });
    return res;
  }

  resolvePath(tpl, item) {
    const d = dateObj(Number(item.createdAt));
    const y = d.getFullYear();
    return String(tpl)
      .replace(/\{Y\}/g, String(y))
      .replace(/\{M\}/g, two(d.getMonth() + 1))
      .replace(/\{D\}/g, two(d.getDate()))
      .replace(/\\/g, '/');
  }

  async ensureFolder(filePath) {
    const segs = filePath.split('/').filter(Boolean);
    segs.pop();
    let cur = '';
    for (const s of segs) {
      cur = cur ? cur + '/' + s : s;
      const af = this.app.vault.getAbstractFileByPath(cur);
      if (!af) {
        try { await this.app.vault.createFolder(cur); } catch (e) { }
      }
    }
  }

  async appendText(filePath, block, head) {
    await this.ensureFolder(filePath);
    const f = this.app.vault.getAbstractFileByPath(filePath);
    const content = block;
    if (!f) {
      const init = (head ? head.replace(/\s*$/, '') + '\n\n' : '') + content;
      await this.app.vault.create(filePath, init + '\n');
      return;
    }
    const old = await this.app.vault.read(f);
    const base = old.replace(/\s+$/, '');
    await this.app.vault.modify(f, (base ? base + '\n\n' : '') + content + '\n');
  }

  headFor(kind) {
    if (kind === 'idea') return '# 灵感收集箱\n\n> [!tip] 收件箱（Inbox）\n> 突发奇想与 idea 逐条追加；一级为时间戳 + 标签，正文用 - 起条目、Tab 缩进来分级。\n> 本文件只负责零摩擦捕获，成熟条目请定期拆分为本目录下的独立笔记。\n';
    if (kind === 'memo') return '# 备忘录\n\n> 由主页「快速记录」归档：一级为时间戳 + 标签，正文用 - 起条目、Tab 缩进来分级。\n';
    if (kind === 'todo') return '# 每日待办\n\n> 本年度当日新增的待办，行尾 📅 标注归属日。\n> 超期未完成项在次日首次打开主页时自动转入「周计划」。\n';
    return '';
  }

  legacyEntry(item) {
    const text = captureText(item.text);
    const created = Number(item.createdAt);
    const id = mark(item.id);
    if (item.type === 'note' || item.type === 'idea' || item.type === 'memo') {
      const tag = item.type === 'note' ? '#随记' : (item.type === 'idea' ? '#灵感收集箱' : '#备忘录');
      const head = '- ' + stampText(created) + ' · ' + tag + ' #微信收集 ' + id;
      const lines = mdOutline(text, 1);
      return lines.length ? head + '\n' + lines.join('\n') : head;
    }
    if (item.type === 'thino') {
      const body = text.split('\n').filter(l => l.trim()).map(l => '\t' + l.replace(/\s+$/, ''));
      if (body.length) body[0] = body[0] + ' #微信收集 ' + id;
      else body.push('\t#微信收集 ' + id);
      return '- ' + hmText(created) + '\n' + body.join('\n');
    }
    if (item.type === 'todo') {
      const one = text.replace(/\s*\n\s*/g, ' / ');
      return '- [ ] ' + one + ' #每日待办 📅 ' + dateText(created) + ' ' + id;
    }
    return '';
  }

  validate(obj, name) {
    if (!obj || typeof obj !== 'object') return 'not object';
    if (['note','idea','thino','memo','todo','nextday'].indexOf(obj.type) < 0) return 'bad type';
    if (typeof obj.id !== 'string' || !ID_RE.test(obj.id)) return 'bad id';
    if (this.settings.bound && this.settings.bindCode && obj.bindCode !== this.settings.bindCode) return 'bind code mismatch';
    if (!Number.isFinite(Number(obj.createdAt))) return 'bad createdAt';
    const cm = Number(obj.createdAt);
    if (cm < 946684800000 || cm > Date.now() + 86400000) return 'bad createdAt';
    if (typeof obj.text !== 'string' || !obj.text.trim()) return 'empty text';
    if (obj.text.length > 20000) return 'text too long';
    if (obj.type === 'nextday') {
      const due = this.dueDate(obj);
      if (!Number.isFinite(due)) return 'bad dueDate';
      if (due < cm - 86400000) return 'dueDate too old';
    }
    if (name !== obj.type + '__' + obj.id + '.json') return 'name mismatch';
    return '';
  }

  async alreadyWritten(item) {
    const p = this.legacyTarget(item);
    if (!p) return false;
    const f = this.app.vault.getAbstractFileByPath(p);
    if (!f) return false;
    try { return (await this.app.vault.read(f)).indexOf(markCore(item.id)) >= 0; } catch (e) { return false; }
  }

  legacyTarget(item) {
    const d = dateObj(Number(item.createdAt));
    const y = d.getFullYear();
    if (item.type === 'note') return this.resolvePath(this.settings.notePath, item);
    if (item.type === 'idea') return this.resolvePath(this.settings.ideaPath, item);
    if (item.type === 'memo') return this.resolvePath(this.settings.memoPath, item);
    if (item.type === 'thino') return this.resolvePath(this.settings.thinoDir + '/{Y}/{Y}-{M}-{D}.md', item);
    if (item.type === 'todo') return this.resolvePath(this.settings.todoPath, item);
    return '';
  }

  async sync() {
    if (this.syncing) return;
    if (!this.settings.bound || !this.settings.user || !this.settings.pass) return;
    this.syncing = true;
    let ok = 0, skip = 0, bad = 0;
    try {
      const base = this.davBase();
      const listRes = await obsidian.requestUrl({
        url: base, method: 'PROPFIND',
        headers: Object.assign({ Authorization: this.auth(), Depth: '1' }), throw: false
      });
      if (!listRes || listRes.status < 200 || listRes.status >= 300) {
        this.updateStatus();
        return;
      }
      const selfName = base.replace(/\/$/, '').split('/').pop();
      const hrefs = parseHrefs(listRes.text || '').filter(h => /\.json$/i.test(h) && !h.endsWith('/' + selfName));
      for (const href of hrefs) {
        const abs = /^https?:\/\//i.test(href) ? href : new URL(href, base).href;
        const name = decodeURIComponent(abs.split('/').pop());
        let obj;
        try {
          const r = await obsidian.requestUrl({ url: abs, method: 'GET', headers: { Authorization: this.auth() }, throw: false });
          obj = JSON.parse(r.text || '');
        } catch (e) { bad++; continue; }
        const err = this.validate(obj, name);
        if (err) { bad++; continue; }
        if (obj.type === 'nextday') {
          const pending = Array.isArray(this.settings.pendingNext) ? this.settings.pendingNext : [];
          if (!pending.some(x => x && x.id === obj.id)) {
            pending.push({
              id: obj.id,
              type: 'todo',
              text: obj.text,
              createdAt: Number(obj.createdAt),
              dueDate: obj.dueDate,
              bindCode: obj.bindCode,
              device: obj.device
            });
            this.settings.pendingNext = pending;
          }
          try { await obsidian.requestUrl({ url: abs, method: 'DELETE', headers: { Authorization: this.auth() }, throw: false }); } catch (e) { }
          ok++;
          continue;
        }
        if (await this.alreadyWritten(obj)) {
          skip++;
          try { await obsidian.requestUrl({ url: abs, method: 'DELETE', headers: { Authorization: this.auth() }, throw: false }); } catch (e) { }
          continue;
        }
        try {
          const target = this.legacyTarget(obj);
          await this.appendText(target, this.legacyEntry(obj), this.headFor(obj.type));
          ok++;
          try { await obsidian.requestUrl({ url: abs, method: 'DELETE', headers: { Authorization: this.auth() }, throw: false }); } catch (e) { }
        } catch (e) { bad++; }
      }
      await this.processDue();
      this.settings.lastSync = Date.now();
      await this.saveSettings();
    } finally {
      this.syncing = false;
      this.updateStatus();
    }
  }
}

class SettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'OmniInbox' });
    containerEl.createEl('p', { cls: 'setting-item-description', text: '接收微信小程序的投递，写入位置与主页快速记录一致。' });

    new obsidian.Setting(containerEl)
      .setName('Obsidian 绑定')
      .setDesc(s.bound ? ('已绑定 · ' + s.deviceName + ' · ' + stampText(s.boundAt)) : '在小程序设置页输入下方 6 位绑定码完成连接')
      .addText(text => {
        text.setPlaceholder('6位绑定码').setValue(s.bindCode);
        text.inputEl.setAttribute('maxlength', '6');
        text.onChange(async v => { s.bindCode = v.trim(); await this.plugin.saveSettings(); });
      })
      .addButton(btn => btn.setButtonText(s.bound ? '解除绑定' : '生成绑定码').onClick(async () => {
        if (s.bound) {
          s.bound = false; s.bindCode = ''; s.boundAt = 0;
        } else {
          s.bindCode = String(Math.floor(100000 + Math.random() * 900000));
          s.bound = true; s.boundAt = Date.now();
        }
        await this.plugin.saveSettings();
        this.display();
      }));

    new obsidian.Setting(containerEl).setName('设备名称').setDesc('绑定时显示的电脑名称')
      .addText(t => t.setValue(s.deviceName).onChange(async v => { s.deviceName = v; await this.plugin.saveSettings(); }));

    containerEl.createEl('h3', { text: '服务器' });
    new obsidian.Setting(containerEl).setName('服务器地址').setDesc('WebDAV 地址')
      .addText(t => t.setPlaceholder('https://dav.jianguoyun.com/dav/').setValue(s.serverUrl).onChange(async v => { s.serverUrl = v.trim(); await this.plugin.saveSettings(); }));
    new obsidian.Setting(containerEl).setName('同步目录').setDesc('坚果云中存放投递文件的目录')
      .addText(t => t.setValue(s.remoteDir).onChange(async v => { s.remoteDir = v.trim(); await this.plugin.saveSettings(); }));
    new obsidian.Setting(containerEl).setName('账号').setDesc('坚果云账号邮箱')
      .addText(t => t.setValue(s.user).onChange(async v => { s.user = v.trim(); await this.plugin.saveSettings(); }));
    new obsidian.Setting(containerEl).setName('应用密码').setDesc('坚果云第三方应用密码，不是登录密码')
      .addText(t => { t.inputEl.type = 'password'; t.setValue(s.pass).onChange(async v => { s.pass = v; await this.plugin.saveSettings(); }); });

    containerEl.createEl('h3', { text: '同步位置（相对笔记库根目录，与主页一致）' });
    const paths = [
      ['随记路径', 'notePath'], ['灵感路径', 'ideaPath'], ['备忘录路径', 'memoPath'],
      ['日记目录', 'thinoDir'], ['每日待办路径', 'todoPath']
    ];
    for (const [label, key] of paths) {
      new obsidian.Setting(containerEl).setName(label)
        .addText(t => t.setValue(s[key]).onChange(async v => { s[key] = v.trim(); await this.plugin.saveSettings(); }));
    }

    containerEl.createEl('h3', { text: '同步选项' });
    new obsidian.Setting(containerEl).setName('自动同步间隔').setDesc('单位分钟，0 表示关闭自动同步')
      .addText(t => t.setValue(String(s.intervalMin)).onChange(async v => { s.intervalMin = Math.max(0, parseInt(v, 10) || 0); await this.plugin.saveSettings(); }));
    new obsidian.Setting(containerEl).setName('状态栏')
      .addToggle(t => t.setValue(s.statusBar).onChange(async v => { s.statusBar = v; await this.plugin.saveSettings(); }));
    new obsidian.Setting(containerEl).setName('立即同步').setDesc('手动拉取一次')
      .addButton(btn => btn.setButtonText('立即同步').onClick(() => this.plugin.sync()));
  }
}
