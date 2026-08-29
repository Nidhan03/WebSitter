// Pre-declares `regeneratorRuntime` as a global in this isolated world before
// tf.min.js loads. Babel's regenerator-runtime bootstrap tries a bare
// `regeneratorRuntime = t` assignment; under strict mode that throws
// (assigning to an undeclared variable), and its catch-block fallback uses
// `Function("r", "regeneratorRuntime = r")` — which violates any page's CSP
// that disallows 'unsafe-eval'. Declaring the variable ahead of time makes
// the assignment a normal (legal) write to an existing var, so the
// eval-based fallback path never runs.
var regeneratorRuntime;
