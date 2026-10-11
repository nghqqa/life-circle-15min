import type { AnalysisResult } from '../shared/types.js';
import { banner } from './hud.js';
import { createProject, MAX_PROJECT_BYTES, parseProject, ProjectStore, serializeProject } from './projects.js';
import type { ProjectSnapshot, WorkbenchSnapshot } from './projects.js';

interface ProjectUiOptions {
  restore(snapshot: ProjectSnapshot): void;
  getResult(): AnalysisResult | null;
  getWorkbench(): WorkbenchSnapshot;
  isBusy(): boolean;
}

/** Browser-only project controls; no provider request is made when saving or restoring. */
export function setupProjects(options: ProjectUiOptions) {
  const store = new ProjectStore();
  const name = document.getElementById('project-name') as HTMLInputElement;
  const list = document.getElementById('project-list') as HTMLSelectElement;
  const fileInput = document.getElementById('project-file') as HTMLInputElement;
  const status = document.getElementById('project-status')!;
  const button = (id: string) => document.getElementById(`project-${id}`) as HTMLButtonElement;
  const save = button('save'), saveAs = button('save-as'), open = button('open');
  const remove = button('delete'), importButton = button('import'), exportButton = button('export');
  let current: ProjectSnapshot | null = null;
  let busy = false, importing = false, revision = 0;

  const blocked = () => busy || importing || options.isBusy();
  function message(text: string, error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
  }
  function fail(error: unknown) {
    const text = error instanceof Error ? error.message : '项目操作失败，当前分析结果已保留。';
    message(text, true);
    banner(text);
  }
  function controls() {
    const disabled = blocked();
    name.disabled = disabled || !options.getResult();
    list.disabled = disabled || list.options.length === 0 || !list.value;
    save.disabled = saveAs.disabled = exportButton.disabled = disabled || !options.getResult();
    open.disabled = remove.disabled = disabled || !list.value;
    importButton.disabled = disabled;
    fileInput.disabled = disabled;
  }
  function refreshList(preferred = current?.id ?? list.value) {
    const entries = store.list();
    list.replaceChildren();
    if (!entries.length) list.add(new Option('暂无本地项目', ''));
    for (const entry of entries) {
      const date = new Date(entry.updatedAt).toLocaleDateString('zh-CN');
      const item = new Option(`${entry.name} · ${date}`, entry.id);
      item.title = `${entry.name} / ${entry.centerName} / ${entry.minutes} 分钟`;
      list.add(item);
    }
    if (entries.some(entry => entry.id === preferred)) list.value = preferred;
    controls();
  }
  function defaultName(result: AnalysisResult) {
    return `${result.centerName || '未命名社区'} · ${result.minutes}分钟`.slice(0, 100);
  }
  function capture(asNew = false): ProjectSnapshot {
    const result = options.getResult();
    if (!result) throw new Error('请先完成一次体检，再保存或导出项目。');
    return createProject(result, options.getWorkbench(), name.value.trim() || defaultName(result), asNew ? undefined : current ?? undefined);
  }
  function persist(snapshot: ProjectSnapshot) {
    // Keep this complete snapshot in memory even if the browser refuses storage.
    current = snapshot;
    name.value = snapshot.name;
    store.save(snapshot);
    refreshList(snapshot.id);
    message(`已保存 · ${new Date(snapshot.updatedAt).toLocaleTimeString('zh-CN')}`);
  }
  function activate(snapshot: ProjectSnapshot) {
    options.restore(snapshot);
    current = snapshot;
    name.value = snapshot.name;
    revision++;
    refreshList(snapshot.id);
    message(`已打开「${snapshot.name}」，已恢复分析与规划选择。`);
  }
  function action(task: () => void) {
    return () => {
      if (blocked()) return;
      try { task(); } catch (error) { fail(error); }
      finally { controls(); }
    };
  }

  save.addEventListener('click', action(() => persist(capture())));
  saveAs.addEventListener('click', action(() => {
    const snapshot = capture(true);
    snapshot.name = `${snapshot.name.slice(0, 95)}（副本）`;
    persist(snapshot);
  }));
  list.addEventListener('change', controls);
  open.addEventListener('click', action(() => {
    const snapshot = store.load(list.value);
    store.setRecent(snapshot.id);
    activate(snapshot);
  }));
  remove.addEventListener('click', action(() => {
    const snapshot = store.load(list.value);
    if (!window.confirm(`从当前浏览器删除「${snapshot.name}」？已导出的项目备份不受影响。`)) return;
    store.remove(snapshot.id);
    if (current?.id === snapshot.id) current = null;
    refreshList();
    message('已删除本地项目。当前画面保留，可另存为或导出备份。');
  }));
  exportButton.addEventListener('click', action(() => {
    const snapshot = capture();
    const blob = new Blob([serializeProject(snapshot)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${snapshot.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}-项目.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message('已导出完整项目，可导入恢复地图与规划选择。');
  }));
  importButton.addEventListener('click', action(() => fileInput.click()));
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || blocked()) return;
    importing = true;
    controls();
    const beforeRevision = revision;
    try {
      if (file.size > MAX_PROJECT_BYTES) throw new Error(`项目文件过大，请导入不超过 ${MAX_PROJECT_BYTES / 1024 / 1024} MB 的完整项目。`);
      const text = await file.text();
      // An analysis can finish while the file picker/reader is open; never overwrite it.
      if (busy || options.isBusy() || beforeRevision !== revision) throw new Error('分析状态已变化，请完成体检后重新导入项目。');
      const parsed = parseProject(text);
      // Import as a separate project so an edited backup cannot overwrite a local one.
      const imported = createProject(parsed.result, parsed.workbench, parsed.name);
      store.save(imported);
      activate(imported);
      message(`已导入「${imported.name}」，保存在当前浏览器。`);
    } catch (error) { fail(error); }
    finally { importing = false; controls(); }
  });

  try {
    refreshList();
    const recent = store.recent();
    if (recent && !options.isBusy()) activate(recent);
  } catch (error) { fail(error); }
  controls();

  return {
    analysisCompleted() {
      revision++;
      current = null;
      const result = options.getResult();
      if (!result) { controls(); return; }
      name.value = defaultName(result);
      try { persist(capture(true)); } catch (error) { fail(error); }
      finally { controls(); }
    },
    workbenchChanged() {
      // A deleted project stays deleted until the user chooses to save it again.
      if (!current || !options.getResult()) return;
      revision++;
      try { persist(capture()); } catch (error) { fail(error); }
      finally { controls(); }
    },
    setBusy(value: boolean) { busy = value; controls(); }
  };
}
