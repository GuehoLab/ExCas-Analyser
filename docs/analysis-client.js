// Starts the analysis worker and forwards its messages to callbacks:
//   new AnalysisClient({ onProgress(pct, message, detail), onDone(result), onError(message) })
//   client.start(params, files, labels); client.cancel();
// detail is the worker's progress message: stage, frac and files { done, total, current }.
// result is the worker's 'done' message: stdout, metrics, outputs, refLen, staged, elapsedMs.
(function () {
  'use strict';

  // Progress-bar range per worker stage, in percent. A stage that reports a fraction
  // (copying the inputs, the two alignments, the report's raw-read check, collecting the
  // results) moves through its range; the others sit at its start. app.js splits the
  // range at run and run2 into the control and treated bars.
  var STAGE_RANGE = {
    load: [0, 2], stage: [2, 14], hash: [14, 15], run: [15, 42], run2: [42, 69],
    post: [69, 71], report: [71, 97], collect: [97, 100]
  };

  function stagePct(stage, frac) {
    var r = STAGE_RANGE[stage];
    if (!r) return 60;
    return r[0] + (r[1] - r[0]) * (frac != null ? Math.max(0, Math.min(1, frac)) : 0);
  }

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
        if (self.cb.onProgress) self.cb.onProgress(stagePct(msg.stage, msg.frac), msg.message || '', msg);
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

  AnalysisClient.STAGE_RANGE = STAGE_RANGE;
  window.AnalysisClient = AnalysisClient;
})();
