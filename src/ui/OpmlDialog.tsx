import { Download, Upload } from "lucide-react";
import { useRef, useState } from "react";
import type { Action, OpmlImport, OpmlPreview } from "../shared/schema";
import { Dialog } from "./Dialog";

type Props = { report: OpmlImport | null | undefined; preview: OpmlPreview | null | undefined; hasFeeds: boolean; act: (action: Action) => Promise<void>; perform: (action: Action) => void };
const resultLabels = { imported: "登録", skipped: "スキップ", failed: "失敗" };
const resolutionLabels = { new: "新規", duplicate: "登録済み", restorable: "復元", invalid: "無効", inFileDuplicate: "重複" };
const isSelectable = (resolution: OpmlPreview["entries"][number]["resolution"]) => resolution === "new" || resolution === "restorable";

export function OpmlDialog({ report, preview, hasFeeds, act, perform }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [xml, setXml] = useState<string | null>(null);
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [pickedMissing, setPickedMissing] = useState<Set<string>>(new Set());
  const [confirmingMissing, setConfirmingMissing] = useState(false);
  const running = report?.status === "running";
  const chosen = preview ? preview.entries.filter((entry) => isSelectable(entry.resolution) && !deselected.has(entry.url)) : [];
  async function readFile(file: File) {
    if (sending || running) return;
    if (file.size > 262_144) { setError("OPMLファイルは256KB以下にしてください。"); return; }
    setSending(true); setError(null);
    try {
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()); }
      catch { throw new Error("UTF-8で保存したOPMLファイルを選択してください。"); }
      setXml(text); setDeselected(new Set()); setPickedMissing(new Set()); setConfirmingMissing(false);
      await act({ type: "opml.preview", xml: text });
    }
    catch (error: unknown) { setXml(null); setError(error instanceof Error ? error.message : "OPMLを読み込めませんでした。"); }
    finally { setSending(false); }
  }
  async function apply() {
    if (!xml || !chosen.length || sending || running) return;
    setSending(true); setError(null);
    try { await act({ type: "opml.import", xml, urls: chosen.map((entry) => entry.url) }); }
    catch (error: unknown) { setError(error instanceof Error ? error.message : "読み込めませんでした。"); }
    finally { setSending(false); }
  }
  async function removeMissing() {
    setConfirmingMissing(false);
    for (const feed of preview?.missingFeeds ?? []) if (pickedMissing.has(feed.id)) await act({ type: "feed.remove", id: feed.id });
    setPickedMissing(new Set());
  }
  function close() {
    setXml(null); setDeselected(new Set()); setPickedMissing(new Set()); setConfirmingMissing(false); setError(null);
    perform({ type: "opml.previewClear" });
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
  return <Dialog id="opml-dialog" title="OPML入出力" onClose={close}>
    <p className="dialog-description" id="opml-help">他のRSSリーダーからフィードを移行できます。UTF-8のOPMLファイル（256KB・200フィードまで）に対応しています。読み込み前に内容を確認して選択できます。既読・スター・AIの会話は移行されません。階層のあるフォルダ名は「親 / 子」にまとめます。</p>
    <div className="opml-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void readFile(file); }}>
      <form onSubmit={(event) => { event.preventDefault(); const file = fileInput.current?.files?.[0]; if (!file) { setError("OPMLファイルを選択してください。"); return; } void readFile(file); }}>
        <label htmlFor="opml-file">読み込むOPMLファイル</label><input ref={fileInput} id="opml-file" name="opml" type="file" accept=".opml,.xml,text/x-opml,text/xml,application/xml" required disabled={sending || running} aria-describedby={error ? "opml-help opml-error" : "opml-help"} aria-invalid={!!error} onChange={() => setError(null)} />
        <p className="dialog-description">ここにファイルをドラッグ＆ドロップすることもできます。</p>
        {error ? <p className="form-error" id="opml-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button className="primary-button" type="submit" disabled={sending || running}><Upload size={14} />{sending ? "ファイルを確認中…" : "OPMLを確認する"}</button>{running ? <button className="secondary-button" type="button" aria-label="OPMLの読み込みを中止" onClick={() => perform({ type: "opml.stop" })}>中止</button> : null}</div>
      </form>
    </div>
    {preview ? <PreviewSection preview={preview} deselected={deselected} toggle={toggle} selectable={selectable} chosen={chosen} setDeselected={setDeselected} pickedMissing={pickedMissing} toggleMissing={toggleMissing} confirmingMissing={confirmingMissing} setConfirmingMissing={setConfirmingMissing} apply={apply} removeMissing={removeMissing} disabled={sending || running} /> : null}
    {report ? <ImportReport report={report} /> : null}
    <div className="opml-export"><h3>登録中のフィードを書き出す</h3><p className="dialog-description">フィードURLとフォルダ名を保存します。記事本文・スター・AIの会話・削除済みのフィードは含みません。</p>{hasFeeds ? <a className="secondary-button" href="/api/opml" download="Reedar.opml"><Download size={14} />OPMLを書き出す</a> : <button className="secondary-button" disabled><Download size={14} />OPMLを書き出す</button>}</div>
  </Dialog>;
}

function PreviewSection({ preview, deselected, toggle, selectable, chosen, setDeselected, pickedMissing, toggleMissing, confirmingMissing, setConfirmingMissing, apply, removeMissing, disabled }: {
  preview: OpmlPreview; deselected: Set<string>; toggle: (url: string, checked: boolean) => void; selectable: string[]; chosen: OpmlPreview["entries"]; setDeselected: (value: Set<string>) => void;
  pickedMissing: Set<string>; toggleMissing: (id: string, checked: boolean) => void; confirmingMissing: boolean; setConfirmingMissing: (value: boolean) => void;
  apply: () => Promise<void>; removeMissing: () => Promise<void>; disabled: boolean;
}) {
  return <section className="opml-preview" aria-label="読み込み内容の確認">
    <p>{preview.entries.length}件中 {chosen.length}件を読み込みます。</p>
    <div className="dialog-actions">
      <button className="text-button" type="button" onClick={() => setDeselected(new Set())}>すべて選択</button>
      <button className="text-button" type="button" onClick={() => setDeselected(new Set(selectable))}>すべて解除</button>
    </div>
    <ul className="opml-preview-list">
      {preview.entries.map((entry, index) => {
        const enabled = isSelectable(entry.resolution);
        return <li key={index} className={enabled ? "" : "opml-entry-disabled"}>
          <label><input type="checkbox" disabled={!enabled || disabled} checked={enabled && !deselected.has(entry.url)} onChange={(event) => toggle(entry.url, event.target.checked)} aria-label={`${entry.title}を選択`} /><span className="opml-entry-body"><strong>{entry.title}</strong><span className="opml-entry-url">{entry.url}</span>{entry.folderName ? <span className="opml-entry-detail">フォルダ: {entry.folderName}</span> : null}{entry.detail ? <span className="opml-entry-detail">{entry.detail}</span> : null}</span><span className={`opml-resolution-${entry.resolution}`}>{resolutionLabels[entry.resolution]}</span></label>
        </li>;
      })}
    </ul>
    <div className="dialog-actions"><button className="primary-button" type="button" disabled={!chosen.length || disabled} onClick={() => void apply()}><Upload size={14} />選択した{chosen.length}件を読み込む</button></div>
    {preview.missingFeeds.length ? <div className="opml-missing">
      <h3>このOPMLに含まれない既存フィード（{preview.missingFeeds.length}件）</h3>
      <p className="dialog-description">削除すると更新を停止します。記事・スター・会話は保持され、後から復元できます。</p>
      <ul className="opml-preview-list">
        {preview.missingFeeds.map((feed) => <li key={feed.id}><label><input type="checkbox" checked={pickedMissing.has(feed.id)} disabled={disabled} onChange={(event) => toggleMissing(feed.id, event.target.checked)} aria-label={`${feed.title}を削除対象に選択`} /><span className="opml-entry-body"><strong>{feed.title}</strong><span className="opml-entry-url">{feed.url}</span>{feed.folderName ? <span className="opml-entry-detail">フォルダ: {feed.folderName}</span> : null}</span></label></li>)}
      </ul>
      {confirmingMissing
        ? <div className="dialog-actions"><button className="primary-button" type="button" disabled={disabled} onClick={() => void removeMissing()}>削除する</button><button className="secondary-button" type="button" onClick={() => setConfirmingMissing(false)}>キャンセル</button></div>
        : <div className="dialog-actions"><button className="secondary-button" type="button" disabled={!pickedMissing.size || disabled} onClick={() => setConfirmingMissing(true)}>選択した{pickedMissing.size}件を削除</button></div>}
    </div> : null}
  </section>;
}

function ImportReport({ report }: { report: OpmlImport }) {
  const running = report.status === "running";
  const counts = { imported: 0, skipped: 0, failed: 0 };
  for (const result of report.results) counts[result.status]++;
  return <section className="opml-report" aria-label="OPMLの読み込み結果"><p role="status">{running ? "読み込み中" : report.status === "cancelled" ? "読み込みを中止しました" : report.status === "failed" ? "読み込みを完了できませんでした" : report.total ? "読み込みが完了しました" : "フィードがありませんでした"} · {report.results.length} / {report.total}件</p>{running ? <progress aria-label="OPMLの読み込み進捗" value={report.results.length} max={report.total || 1} /> : null}<p className="opml-counts">登録 {counts.imported} · スキップ {counts.skipped} · 失敗 {counts.failed}</p>{report.error ? <p className="form-error" role="alert">{report.error}</p> : null}<ul className="opml-results">{report.results.map((result) => <li key={result.id}><div><strong>{result.title}</strong><span className={`opml-result-${result.status}`}>{resultLabels[result.status]}</span></div><p>{result.detail}</p></li>)}</ul>{report.status === "cancelled" ? <p className="dialog-footnote">中止する前に登録が完了したフィードは保持されています。</p> : null}</section>;
}
