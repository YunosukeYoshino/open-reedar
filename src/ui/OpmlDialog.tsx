import { Download, Sparkles, Upload } from "lucide-react";
import { useRef, useState } from "react";
import type { Action, Agent, LibraryExport, OpmlImport, OpmlPreview, OrganizeJob } from "../shared/schema";
import { libraryExportSchema } from "../shared/schema";
import { Dialog } from "./Dialog";
import { useT } from "./i18n";

type Props = { report: OpmlImport | null | undefined; preview: OpmlPreview | null | undefined; hasFeeds: boolean; act: (action: Action) => Promise<unknown>; perform: (action: Action) => void; organize: OrganizeJob | null | undefined; agent: Agent | null };
const isSelectable = (resolution: OpmlPreview["entries"][number]["resolution"]) => resolution === "new" || resolution === "restorable";

export function OpmlDialog({ report, preview, hasFeeds, act, perform, organize, agent }: Props) {
  const t = useT();
  const fileInput = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [xml, setXml] = useState<string | null>(null);
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [pickedMissing, setPickedMissing] = useState<Set<string>>(new Set());
  const [confirmingMissing, setConfirmingMissing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{ json: string; doc: LibraryExport } | null>(null);
  const running = report?.status === "running";
  const chosen = preview ? preview.entries.filter((entry) => isSelectable(entry.resolution) && !deselected.has(entry.url)) : [];
  async function readFile(file: File) {
    if (sending || running) return;
    if (file.size > 262_144) { setError(t("opml.fileTooLarge")); return; }
    setSending(true); setError(null);
    try {
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
      catch { throw new Error(t("opml.fileNotUtf8")); }
      setXml(text); setDeselected(new Set()); setPickedMissing(new Set()); setConfirmingMissing(false);
      await act({ type: "opml.preview", xml: text });
    }
    catch (error: unknown) { setXml(null); setError(error instanceof Error ? error.message : t("opml.readFailed")); }
    finally { setSending(false); }
  }
  async function apply() {
    if (!xml || !chosen.length || sending || running) return;
    setSending(true); setError(null);
    try {
      const folders = Object.fromEntries(chosen.flatMap((entry) => entry.folderName ? [[entry.url, entry.folderName]] : []));
      await act({ type: "opml.import", xml, urls: chosen.map((entry) => entry.url), ...(Object.keys(folders).length ? { folders } : {}) });
    }
    catch (error: unknown) { setError(error instanceof Error ? error.message : t("opml.importFailed")); }
    finally { setSending(false); }
  }
  async function removeMissing() {
    setConfirmingMissing(false);
    for (const feed of preview?.missingFeeds ?? []) if (pickedMissing.has(feed.id)) await act({ type: "feed.remove", id: feed.id });
    setPickedMissing(new Set());
  }
  function close() {
    setXml(null); setDeselected(new Set()); setPickedMissing(new Set()); setConfirmingMissing(false); setError(null);
    setLibraryError(null); setPendingRestore(null); setRestored(false);
    perform({ type: "opml.previewClear" });
    if (organize?.scope === "opml") perform({ type: "organize.cancel" });
  }
  async function exportLibrary() {
    if (exporting || restoring) return;
    setExporting(true); setLibraryError(null); setRestored(false);
    try {
      const outcome = await act({ type: "library.export" }) as { result?: unknown };
      const parsed = libraryExportSchema.safeParse(outcome?.result);
      if (!parsed.success) throw new Error(t("library.exportFailed"));
      const url = URL.createObjectURL(new Blob([JSON.stringify(parsed.data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `open-reedar-library-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    }
    catch (cause: unknown) { setLibraryError(cause instanceof Error ? cause.message : t("library.exportFailed")); }
    finally { setExporting(false); }
  }
  async function readLibraryFile(file: File) {
    setLibraryError(null); setRestored(false); setPendingRestore(null);
    if (file.size > 32 * 1024 * 1024) { setLibraryError(t("library.fileTooLarge")); return; }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
    catch { setLibraryError(t("library.readFailed")); return; }
    let parsed: ReturnType<typeof libraryExportSchema.safeParse>;
    try { parsed = libraryExportSchema.safeParse(JSON.parse(text)); }
    catch { setLibraryError(t("library.invalidFile")); return; }
    if (!parsed.success) { setLibraryError(t("library.invalidFile")); return; }
    setPendingRestore({ json: text, doc: parsed.data });
  }
  async function restoreLibrary() {
    if (!pendingRestore || restoring) return;
    setRestoring(true); setLibraryError(null);
    try {
      await act({ type: "library.import", json: pendingRestore.json });
      setPendingRestore(null);
      setRestored(true);
    }
    catch (cause: unknown) { setLibraryError(cause instanceof Error ? cause.message : t("library.restoreFailed")); }
    finally { setRestoring(false); }
  }
  function toggle(url: string, checked: boolean) {
    const next = new Set(deselected);
    if (checked) next.delete(url); else next.add(url);
    setDeselected(next);
  }
  function toggleMissing(id: string, checked: boolean) {
    const next = new Set(pickedMissing);
    if (checked) next.add(id); else next.delete(id);
    setPickedMissing(next);
  }
  const selectable = preview ? preview.entries.filter((entry) => isSelectable(entry.resolution)).map((entry) => entry.url) : [];
  return <Dialog id="opml-dialog" title={t("opml.title")} onClose={close}>
    <p className="dialog-description" id="opml-help">{t("opml.description")}</p>
    <div className="opml-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void readFile(file); }}>
      <form onSubmit={(event) => { event.preventDefault(); const file = fileInput.current?.files?.[0]; if (!file) { setError(t("opml.fileRequired")); return; } void readFile(file); }}>
        <label htmlFor="opml-file">{t("opml.fileLabel")}</label><input ref={fileInput} id="opml-file" name="opml" type="file" accept=".opml,.xml,text/x-opml,text/xml,application/xml" required disabled={sending || running} aria-describedby={error ? "opml-help opml-error" : "opml-help"} aria-invalid={!!error} onChange={() => setError(null)} />
        <p className="dialog-description">{t("opml.dropHint")}</p>
        {error ? <p className="form-error" id="opml-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button className="primary-button" type="submit" disabled={sending || running}><Upload size={14} />{sending ? t("opml.checking") : t("opml.preview")}</button>{running ? <button className="secondary-button" type="button" aria-label={t("opml.stopAria")} onClick={() => perform({ type: "opml.stop" })}>{t("opml.stop")}</button> : null}</div>
      </form>
    </div>
    {preview ? <PreviewSection preview={preview} deselected={deselected} toggle={toggle} selectable={selectable} chosen={chosen} setDeselected={setDeselected} pickedMissing={pickedMissing} toggleMissing={toggleMissing} confirmingMissing={confirmingMissing} setConfirmingMissing={setConfirmingMissing} apply={apply} removeMissing={removeMissing} disabled={sending || running} organize={organize} agent={agent} act={act} perform={perform} /> : null}
    {report ? <ImportReport report={report} /> : null}
    <div className="opml-export"><h3>{t("opml.exportTitle")}</h3><p className="dialog-description">{t("opml.exportDescription")}</p>{hasFeeds ? <a className="secondary-button" href="/api/opml" download="Reedar.opml"><Download size={14} />{t("opml.export")}</a> : <button className="secondary-button" disabled><Download size={14} />{t("opml.export")}</button>}</div>
    <div className="opml-export">
      <h3>{t("library.backupTitle")}</h3>
      <p className="dialog-description">{t("library.backupDescription")}</p>
      <button className="secondary-button" type="button" disabled={exporting || restoring} onClick={() => void exportLibrary()}><Download size={14} />{exporting ? t("library.exporting") : t("library.export")}</button>
      <form onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="library-file">{t("library.fileLabel")}</label>
        <input id="library-file" name="library" type="file" accept=".json,application/json" disabled={restoring || exporting} aria-invalid={!!libraryError} onChange={(event) => { const file = event.target.files?.[0]; if (file) void readLibraryFile(file); event.target.value = ""; }} />
      </form>
      {libraryError ? <p className="form-error" role="alert">{libraryError}</p> : null}
      {restored ? <p className="dialog-description" role="status">{t("library.restored")}</p> : null}
      {pendingRestore ? <section className="opml-preview" aria-label={t("library.restoreApply")}>
        <p>{t("library.restoreSummary", { feeds: pendingRestore.doc.feeds.length, folders: pendingRestore.doc.folders.length, articles: pendingRestore.doc.articles.length })}</p>
        <div className="dialog-actions">
          <button className="primary-button" type="button" disabled={restoring} onClick={() => void restoreLibrary()}><Upload size={14} />{restoring ? t("library.exporting") : t("library.restoreApply")}</button>
          <button className="secondary-button" type="button" disabled={restoring} onClick={() => setPendingRestore(null)}>{t("app.cancel")}</button>
        </div>
      </section> : null}
    </div>
  </Dialog>;
}

function PreviewSection({ preview, deselected, toggle, selectable, chosen, setDeselected, pickedMissing, toggleMissing, confirmingMissing, setConfirmingMissing, apply, removeMissing, disabled, organize, agent, act, perform }: {
  preview: OpmlPreview; deselected: Set<string>; toggle: (url: string, checked: boolean) => void; selectable: string[]; chosen: OpmlPreview["entries"]; setDeselected: (value: Set<string>) => void;
  pickedMissing: Set<string>; toggleMissing: (id: string, checked: boolean) => void; confirmingMissing: boolean; setConfirmingMissing: (value: boolean) => void;
  apply: () => Promise<void>; removeMissing: () => Promise<void>; disabled: boolean;
  organize: OrganizeJob | null | undefined; agent: Agent | null; act: (action: Action) => Promise<unknown>; perform: (action: Action) => void;
}) {
  const t = useT();
  const job = organize?.scope === "opml" ? organize : null;
  const assignments = job?.plan?.assignments ?? [];
  return <section className="opml-preview" aria-label={t("opml.previewTitle")}>
    <p>{t("opml.importing", { chosen: chosen.length, total: preview.entries.length })}</p>
    <div className="dialog-actions">
      <button className="text-button" type="button" onClick={() => setDeselected(new Set())}>{t("opml.selectAll")}</button>
      <button className="text-button" type="button" onClick={() => setDeselected(new Set(selectable))}>{t("opml.selectNone")}</button>
      {agent ? <button className="text-button" type="button" disabled={disabled || job?.status === "running"} onClick={() => void act({ type: "organize.propose", agent, scope: "opml" })}><Sparkles size={12} />{t("opml.aiFolders")}</button> : null}
    </div>
    {job ? <div className="dialog-actions organize-banner">
      {job.status === "running" ? <><p className="dialog-description">{t("opml.aiAsking")}</p><button className="secondary-button" type="button" onClick={() => perform({ type: "organize.cancel" })}>{t("organize.cancel")}</button></> : null}
      {job.status === "failed" ? <p className="form-error" role="alert">{job.detail ?? t("opml.aiFailed")}</p> : null}
      {job.status === "completed" ? (assignments.length ? <>
        <p className="dialog-description">{t("opml.aiBanner", { count: assignments.length })}</p>
        <button className="primary-button" type="button" disabled={disabled} onClick={() => void act({ type: "organize.apply", assignments: assignments.map((item) => ({ url: item.url, folderName: item.folderName })) })}>{t("opml.apply")}</button>
        <button className="secondary-button" type="button" onClick={() => perform({ type: "organize.clear" })}>{t("organize.discard")}</button>
      </> : <>
        <p className="dialog-description">{t("opml.noAssignments")}</p>
        <button className="secondary-button" type="button" onClick={() => perform({ type: "organize.clear" })}>{t("app.close")}</button>
      </>) : null}
    </div> : null}
    <ul className="opml-preview-list">
      {preview.entries.map((entry, index) => {
        const enabled = isSelectable(entry.resolution);
        return <li key={index} className={enabled ? "" : "opml-entry-disabled"}>
          <label><input type="checkbox" disabled={!enabled || disabled} checked={enabled && !deselected.has(entry.url)} onChange={(event) => toggle(entry.url, event.target.checked)} aria-label={t("opml.select", { title: entry.title })} /><span className="opml-entry-body"><strong>{entry.title}</strong><span className="opml-entry-url">{entry.url}</span>{entry.folderName ? <span className="opml-entry-detail">{t("opml.folderLabel", { name: entry.folderName })}</span> : null}{entry.detail ? <span className="opml-entry-detail">{entry.detail}</span> : null}</span><span className={`opml-resolution-${entry.resolution}`}>{t(`opml.resolution.${entry.resolution}`)}</span></label>
        </li>;
      })}
    </ul>
    <div className="dialog-actions"><button className="primary-button" type="button" disabled={!chosen.length || disabled} onClick={() => void apply()}><Upload size={14} />{t("opml.importSelected", { count: chosen.length })}</button></div>
    {preview.missingFeeds.length ? <div className="opml-missing">
      <h3>{t("opml.missingTitle", { count: preview.missingFeeds.length })}</h3>
      <p className="dialog-description">{t("opml.missingDescription")}</p>
      <ul className="opml-preview-list">
        {preview.missingFeeds.map((feed) => <li key={feed.id}><label><input type="checkbox" checked={pickedMissing.has(feed.id)} disabled={disabled} onChange={(event) => toggleMissing(feed.id, event.target.checked)} aria-label={t("opml.missingSelect", { title: feed.title })} /><span className="opml-entry-body"><strong>{feed.title}</strong><span className="opml-entry-url">{feed.url}</span>{feed.folderName ? <span className="opml-entry-detail">{t("opml.folderLabel", { name: feed.folderName })}</span> : null}</span></label></li>)}
      </ul>
      {confirmingMissing
        ? <div className="dialog-actions"><button className="primary-button" type="button" disabled={disabled} onClick={() => void removeMissing()}>{t("opml.missingRemove")}</button><button className="secondary-button" type="button" onClick={() => setConfirmingMissing(false)}>{t("opml.missingCancel")}</button></div>
        : <div className="dialog-actions"><button className="secondary-button" type="button" disabled={!pickedMissing.size || disabled} onClick={() => setConfirmingMissing(true)}>{t("opml.missingPicked", { count: pickedMissing.size })}</button></div>}
    </div> : null}
  </section>;
}

function ImportReport({ report }: { report: OpmlImport }) {
  const t = useT();
  const running = report.status === "running";
  const counts = { imported: 0, skipped: 0, failed: 0 };
  for (const result of report.results) counts[result.status]++;
  return <section className="opml-report" aria-label={t("opml.reportTitle")}><p role="status">{running ? t("opml.statusRunning") : report.status === "cancelled" ? t("opml.statusCancelled") : report.status === "failed" ? t("opml.statusFailed") : report.total ? t("opml.statusDone") : t("opml.statusEmpty")} · {report.results.length} / {report.total}</p>{running ? <progress aria-label={t("opml.progressAria")} value={report.results.length} max={report.total || 1} /> : null}<p className="opml-counts">{t("opml.counts", { imported: counts.imported, skipped: counts.skipped, failed: counts.failed })}</p>{report.error ? <p className="form-error" role="alert">{report.error}</p> : null}<ul className="opml-results">{report.results.map((result) => <li key={result.id}><div><strong>{result.title}</strong><span className={`opml-result-${result.status}`}>{t(`opml.result.${result.status}`)}</span></div><p>{result.detail}</p></li>)}</ul>{report.status === "cancelled" ? <p className="dialog-footnote">{t("opml.cancelNote")}</p> : null}</section>;
}
