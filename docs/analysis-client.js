// Starts the analysis worker and forwards its messages to callbacks:
//   new AnalysisClient({ onProgress(pct, message), onDone(result), onError(message) })
//   client.start(params, files, labels); client.cancel();
// result is the worker's 'done' message: stdout, metrics, outputs, refLen, staged, elapsedMs.
(function () {
  'use strict';

  // Progress-bar percent per worker stage. Only 'stage' (copying the input files)
  // reports a real fraction; the core reports only when a stage ends.
  var STAGE_PCT = { load: 10, stage: 12, run: 40, run2: 62, post: 82, report: 90, collect: 96 };

  function AnalysisClient(callbacks) {
    this.cb = callbacks || {};
    this.worker = null;
    this._cancelled = false;
  }

  AnalysisClient.prototype.start = function (params, files, labels) {
    var self = this;
    this._cancelled = false;
    this.cancel();                      // never leave an old run running
    this._cancelled = false;

    var w = new Worker('worker.js');
    this.worker = w;

    w.onmessage = function (ev) {
      if (self._cancelled) return;
      var msg = ev.data || {};

      if (msg.type === 'progress') {
        var pct = (msg.stage === 'stage' && msg.frac != null)
          ? 12 + 23 * msg.frac
          : (STAGE_PCT[msg.stage] != null ? STAGE_PCT[msg.stage] : 60);
        if (self.cb.onProgress) self.cb.onProgress(pct, msg.message || '');
        return;
      }
      if (msg.type === 'done') {
        if (self.cb.onProgress) self.cb.onProgress(100, 'Done');
        if (self.cb.onDone) self.cb.onDone(msg);
        self.cancel();
        return;
      }
      if (msg.type === 'error') {
        if (self.cb.onError) self.cb.onError(msg.message || 'unknown worker error');
        self.cancel();
      }
    };

    w.onerror = function (e) {
      if (self._cancelled) return;
      if (self.cb.onError) self.cb.onError(e.message || 'worker failed to start');
      self.cancel();
    };

    // The File objects go to the worker unread; it reads and unzips them.
    w.postMessage({ type: 'run', params: params, files: files, labels: labels });
  };

  AnalysisClient.prototype.cancel = function () {
    this._cancelled = true;
    if (this.worker) {
      try { this.worker.terminate(); } catch (_) {}
      this.worker = null;
    }
  };

  window.AnalysisClient = AnalysisClient;
})();
