import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { TraceRecorder } from './utils/trace';
import {
  TraceViewHostMessage,
  buildTraceViewHtml,
  isTraceViewClientMessage,
  toTraceViewItem,
} from './utils/trace-view-html';

/**
 * "Bespoke AI: Show Recent Completions" — a single webview panel listing this window's
 * trace records (newest first), live-updating as new records arrive.
 */
export class TraceViewPanel {
  private static current: TraceViewPanel | undefined;

  static show(recorder: TraceRecorder): void {
    if (TraceViewPanel.current) {
      TraceViewPanel.current.panel.reveal();
      return;
    }
    TraceViewPanel.current = new TraceViewPanel(recorder);
  }

  static disposeCurrent(): void {
    TraceViewPanel.current?.panel.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;

  private constructor(private readonly recorder: TraceRecorder) {
    this.panel = vscode.window.createWebviewPanel(
      'bespokeAI.recentCompletions',
      'Bespoke AI: Recent Completions',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [] },
    );
    this.panel.webview.html = buildTraceViewHtml(crypto.randomBytes(18).toString('base64'));

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: unknown) => {
        if (!isTraceViewClientMessage(msg)) return;
        if (msg.type === 'ready') {
          // Sent on every (re)load, e.g. after the panel is hidden and shown again.
          this.ready = true;
          this.postSnapshot();
        } else if (msg.type === 'clear') {
          this.recorder.clear();
          this.postSnapshot();
        }
      }),
      this.recorder.onDidRecord((record) => {
        if (!this.ready) return;
        this.post({ type: 'append', item: toTraceViewItem(record) });
      }),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private postSnapshot(): void {
    this.post({
      type: 'snapshot',
      items: this.recorder.getRecent().map(toTraceViewItem),
      captureContent: this.recorder.isCapturingContent,
    });
  }

  private post(message: TraceViewHostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    if (TraceViewPanel.current === this) TraceViewPanel.current = undefined;
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
