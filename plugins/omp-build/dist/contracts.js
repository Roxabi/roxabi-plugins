// node_modules/@oh-my-pi/pi-ai/src/error/classes.ts
var MAX_ANTHROPIC_ERROR_BODY_BYTES = 64 * 1024;

// node_modules/@oh-my-pi/pi-ai/src/error/rate-limit.ts
var QUOTA_EXHAUSTED_BACKOFF_MS = 30 * 60 * 1000;
var RATE_LIMIT_EXCEEDED_BACKOFF_MS = 30 * 1000;
var CONCURRENT_LIMIT_BACKOFF_MS = 5 * 1000;
var MODEL_CAPACITY_BASE_MS = 45 * 1000;
var MODEL_CAPACITY_JITTER_MS = 30 * 1000;
var SERVER_ERROR_BACKOFF_MS = 20 * 1000;
var LONG_RATE_LIMIT_DELAY_MS = 5 * 60 * 1000;

// node_modules/@oh-my-pi/pi-ai/src/error/flags.ts
var Flag = {
  Class: 4096,
  ThinkingLoop: 65536,
  Transient: 131072,
  Timeout: 262144,
  UsageLimit: 524288,
  StaleResponsesItem: 1048576,
  MalformedFunctionCall: 2097152,
  ProviderFinishError: 4194304,
  EmptyResponse: 8192,
  ContentBlocked: 32768,
  AccountPolicy: 16384,
  ContextOverflow: 8388608,
  AuthFailed: 16777216,
  SilentAbort: 33554432,
  UserInterrupt: 67108864,
  Abort: 134217728,
  Grammar: 268435456,
  FastModeUnsupported: 536870912,
  OAuthExpiry: 1073741824,
  CacheControlUnsupported: 2048,
  PayloadRejected: 2147483648
};
var KIND_MASK = Flag.ThinkingLoop | Flag.Transient | Flag.Timeout | Flag.UsageLimit | Flag.StaleResponsesItem | Flag.MalformedFunctionCall | Flag.ProviderFinishError | Flag.EmptyResponse | Flag.ContentBlocked | Flag.AccountPolicy | Flag.ContextOverflow | Flag.AuthFailed | Flag.PayloadRejected | Flag.SilentAbort | Flag.UserInterrupt | Flag.Abort | Flag.Grammar | Flag.FastModeUnsupported | Flag.CacheControlUnsupported | Flag.OAuthExpiry;
var RETRIABLE_KINDS = Flag.Transient | Flag.UsageLimit | Flag.ThinkingLoop | Flag.StaleResponsesItem | Flag.ProviderFinishError | Flag.EmptyResponse;
var CONTEXT_OVERFLOW_EVIDENCE_PATTERNS = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the available context size/i,
  /\bprompt\s*\(\s*\d+\s+tokens\s*\)\s*\+\s*max\s+tokens\s*\(\s*\d+\s*\)\s+exceeds\s+the\s+context\s*\(\s*\d+\s*\)/i,
  /\bprompt\s*\(\s*\d+\s+tokens\s*\)\s+leaves\s+no\s+room\s+to\s+answer\s+in\s+the\s+context\s*\(\s*\d+\s*\)/i,
  /requested tokens?.*exceed.*context (window|length|size)/i,
  /context (window|length|size).*(exceeded|overflow|too small)/i,
  /(prompt|input).*(too long|too large).*(context|n_ctx)/i,
  /requested tokens?.*(exceeds?|greater than).*(n_ctx|context)/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /request_too_large[^\n]*\btokens?\b/i,
  /\btokens?\b[^\n]*request_too_large/i,
  /model_context_window_exceeded/i,
  /prompt filled the context window/i,
  /exceeds the limit of \d+ tokens?\b/i,
  /chat history exceeds the \d+-message limit/i
];
var GENERIC_LIMIT_OVERFLOW_PATTERN = /exceeds the limit of \d+/i;
var OVERFLOW_PATTERNS = [...CONTEXT_OVERFLOW_EVIDENCE_PATTERNS, GENERIC_LIMIT_OVERFLOW_PATTERN];
var ERROR_KIND_LABELS = [
  [Flag.ThinkingLoop, "thinking-loop"],
  [Flag.Transient, "transient"],
  [Flag.Timeout, "timeout"],
  [Flag.UsageLimit, "usage-limit"],
  [Flag.StaleResponsesItem, "stale-responses-item"],
  [Flag.MalformedFunctionCall, "malformed-function-call"],
  [Flag.ProviderFinishError, "provider-finish-error"],
  [Flag.EmptyResponse, "empty-response"],
  [Flag.ContentBlocked, "content-blocked"],
  [Flag.AccountPolicy, "account-policy"],
  [Flag.ContextOverflow, "context-overflow"],
  [Flag.PayloadRejected, "payload-rejected"],
  [Flag.AuthFailed, "auth-failed"],
  [Flag.SilentAbort, "silent-abort"],
  [Flag.UserInterrupt, "user-interrupt"],
  [Flag.Abort, "abort"]
];
function is(id, flag) {
  return ((id ?? 0) & flag) !== 0;
}

// plugins/omp-build/engine/record-diagnostics.ts
var incompatibleFormat = "incompatible-format";
function diagnostic(code, message, detail) {
  return detail === undefined ? { code, message } : { code, message, detail };
}
function fail(diagnostics, metadata = {}) {
  return { ok: false, diagnostics, ...metadata };
}
function equalScope(left, right) {
  return left.repository === right.repository && left.target === right.target;
}
function sameRef(left, right) {
  return left.recordId === right.recordId && left.kind === right.kind && equalScope(left.scope, right.scope);
}

// plugins/omp-build/engine/record-format.ts
var REVIEW_INPUT_FORMAT = "omp-build:review-input/3";
var MANDATE_FORMAT = "omp-build-mandate/2";
function incompatible(message) {
  return { code: incompatibleFormat, message };
}
function recordFormatDiagnostic(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const record = value;
  if (record.kind === "proof")
    return incompatible("Record kind 'proof' was removed in #902 and cannot authorize anything");
  if (record.kind === "mandate") {
    const payload = record.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload) || "proofPins" in payload || payload.format !== MANDATE_FORMAT) {
      return incompatible(`Mandate format must be ${MANDATE_FORMAT}; pre-#902 mandates (proof pins) cannot authorize landing`);
    }
  }
  if (record.kind !== "review-attempt" && record.kind !== "review" || record.payload === null || typeof record.payload !== "object")
    return null;
  const payload = record.payload;
  const snapshot = payload.inputSnapshot;
  if (snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot) && (("semctxParts" in snapshot) || ("assertledgerParts" in snapshot))) {
    return incompatible(`Review input expects ${REVIEW_INPUT_FORMAT} without external producer parts`);
  }
  if (payload.inputFormat !== REVIEW_INPUT_FORMAT)
    return incompatible(`Review input format must be ${REVIEW_INPUT_FORMAT}`);
  return null;
}

// node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function joinValues(array, separator = "|") {
  return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}

class Cached {
  constructor(getter) {
    this._getter = getter;
    this._value = undefined;
  }
  get value() {
    const getter = this._getter;
    if (getter !== undefined) {
      this._value = getter();
      this._getter = undefined;
    }
    return this._value;
  }
}
function cached(getter) {
  return new Cached(getter);
}
function nullish(input) {
  return input === null || input === undefined;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const ratio = val / step;
  const roundedRatio = Math.round(ratio);
  const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(ratio), 1);
  if (Math.abs(ratio - roundedRatio) < tolerance)
    return 0;
  return ratio - roundedRatio;
}
var EVALUATING = /* @__PURE__ */ Symbol("evaluating");
function defineLazy(object, key, getter) {
  let value = undefined;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) {
        return;
      }
      if (value === undefined) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object, key, {
        value: v
      });
    },
    configurable: true
  });
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function rawShape(def) {
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  return desc?.get ? desc.get.raw : desc?.value;
}
function sourceShape(schema) {
  return rawShape(schema._zod.def) ?? schema._zod.def.shape;
}
function deferProp(target, key, getter) {
  Object.defineProperty(target, key, {
    get() {
      const value = getter();
      assignProp(this, key, value);
      return value;
    },
    enumerable: true,
    configurable: true
  });
}
function putProp(target, key, value) {
  if (key in target)
    assignProp(target, key, value);
  else
    target[key] = value;
}
function mirrorShape(target, source, keys, wrap) {
  const raw = sourceShape(source);
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc.enumerable)
      continue;
    if (desc.get) {
      deferProp(target, key, () => {
        const value = source._zod.def.shape[key];
        return wrap ? wrap(value, key) : value;
      });
    } else
      putProp(target, key, wrap ? wrap(desc.value, key) : desc.value);
  }
}
function mirrorProps(target, source) {
  for (const key of Reflect.ownKeys(source)) {
    const desc = Object.getOwnPropertyDescriptor(source, key);
    if (!desc.enumerable)
      continue;
    if (desc.get)
      deferProp(target, key, () => source[key]);
    else
      putProp(target, key, desc.value);
  }
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
  return JSON.stringify(str);
}
function slugify(input) {
  return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = /* @__PURE__ */ cached(() => {
  if (globalConfig.jitless) {
    return false;
  }
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === undefined)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  if (o instanceof Map)
    return new Map(o);
  if (o instanceof Set)
    return new Set(o);
  return o;
}
var propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== undefined) {
    if (params?.error !== undefined)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function stringifyPrimitive(value) {
  if (typeof value === "bigint")
    return value.toString() + "n";
  if (typeof value === "string")
    return `"${value}"`;
  return `${value}`;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin !== undefined && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = /* @__PURE__ */ (() => ({
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-340282346638528860000000000000000000000, 340282346638528860000000000000000000000],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
}))();
var BIGINT_FORMAT_RANGES = {
  int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
  uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  }
  const newShape = {};
  mirrorShape(newShape, schema, maskedKeys(schema, mask));
  return clone(schema, mergeDefs(currDef, { shape: newShape, checks: [] }));
}
function maskedKeys(schema, mask) {
  const raw = sourceShape(schema);
  const keys = [];
  for (const key of Reflect.ownKeys(mask)) {
    if (!Object.getOwnPropertyDescriptor(raw, key)?.enumerable) {
      throw new Error(`Unrecognized key: "${String(key)}"`);
    }
    if (mask[key])
      keys.push(key);
  }
  return keys;
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".omit() cannot be used on object schemas containing refinements");
  }
  const omitted = new Set(maskedKeys(schema, mask));
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)).filter((key) => !omitted.has(key)));
  return clone(schema, mergeDefs(currDef, { shape: newShape, checks: [] }));
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    const existingShape = sourceShape(schema);
    for (const key of Reflect.ownKeys(shape)) {
      if (Object.getOwnPropertyDescriptor(existingShape, key) !== undefined) {
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
      }
    }
  }
  return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function extended(schema, shape) {
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)));
  mirrorProps(newShape, shape);
  return newShape;
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function merge(a, b) {
  if (!b?._zod?.def) {
    throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
  }
  if (a._zod.def.checks?.length) {
    throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
  }
  const newShape = {};
  mirrorShape(newShape, a, Reflect.ownKeys(sourceShape(a)));
  mirrorShape(newShape, b, Reflect.ownKeys(sourceShape(b)));
  const def = mergeDefs(a._zod.def, {
    shape: newShape,
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: b._zod.def.checks ?? []
  });
  return clone(a, def);
}
function partial(Class, schema, mask, name = "partial") {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(`.${name}() cannot be used on object schemas containing refinements`);
  }
  const selected = mask ? new Set(maskedKeys(schema, mask)) : undefined;
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), Class && ((value, key) => selected && !selected.has(key) ? value : new Class({ type: "optional", innerType: value })));
  return clone(schema, mergeDefs(schema._zod.def, { shape: newShape, checks: [] }));
}
function required(Class, schema, mask) {
  const selected = mask ? new Set(maskedKeys(schema, mask)) : undefined;
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), (value, key) => selected && !selected.has(key) ? value : new Class({ type: "nonoptional", innerType: value }));
  return clone(schema, mergeDefs(schema._zod.def, { shape: newShape }));
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a;
    (_a = iss).path ?? (_a.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function sizeCaps(defChecks) {
  const caps = [];
  for (const ch of defChecks ?? []) {
    const d = ch._zod.def;
    if (!/_(length|size)$|_equals$/.test(d.check))
      break;
    const max = d.maximum ?? d.length ?? d.size;
    if (max >= 0)
      caps.push([max, ch]);
  }
  return caps;
}
function attachSchema(issues, start, inst) {
  var _a;
  for (let i = start;i < issues.length; i++) {
    (_a = issues[i]).schema ?? (_a.schema = inst);
  }
}
function finalizeIssue(iss, ctx, config) {
  var _a;
  const traits = iss.inst?._zod?.traits;
  if (traits?.has("$ZodType")) {
    if (traits.has("$ZodCheck"))
      (_a = iss).schema ?? (_a.schema = iss.inst);
    else
      iss.schema = iss.inst;
  }
  const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : undefined;
  const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
  const full = {};
  for (const k of Object.keys(iss)) {
    if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__")
      continue;
    full[k] = iss[k];
  }
  full.path ?? (full.path = []);
  full.message = message;
  if (ctx?.reportInput) {
    full.input = iss.input;
  }
  return full;
}
var highSurrogate = /[\uD800-\uDBFF]/;
function codePointLength(str) {
  const units = str.length;
  if (!highSurrogate.test(str))
    return units;
  let count = units;
  for (let i = 0;i < units - 1; i++) {
    if ((str.charCodeAt(i) & 64512) === 55296 && (str.charCodeAt(i + 1) & 64512) === 56320) {
      count--;
      i++;
    }
  }
  return count;
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function parsedType(data) {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "nan" : "number";
    }
    case "object": {
      if (data === null) {
        return "null";
      }
      if (Array.isArray(data)) {
        return "array";
      }
      const obj = data;
      if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) {
        return obj.constructor.name;
      }
    }
  }
  return t;
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function members(proto, table) {
  for (const key in table) {
    const desc = Object.getOwnPropertyDescriptor(table, key);
    if (desc.get)
      Object.defineProperty(proto, key, { ...desc, enumerable: false });
    else
      defineBound(proto, key, desc.value);
  }
}
function own(inst, key, value, enumerable = true) {
  Object.defineProperty(inst, key, { configurable: true, writable: true, enumerable, value });
  return value;
}
function hide(inst, key, value) {
  return own(inst, key, value, false);
}
function derived(computes, table) {
  for (const key in computes) {
    const compute = computes[key];
    Object.defineProperty(table, key, {
      configurable: true,
      enumerable: true,
      get() {
        return own(this, key, compute(this));
      },
      set(value) {
        own(this, key, value);
      }
    });
  }
  return table;
}
function defineBound(proto, key, fn) {
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      return this == null ? fn : own(this, key, fn.bind(this));
    },
    set(value) {
      own(this, key, value);
    }
  });
}
function claim(inst, sentinel) {
  const proto = Object.getPrototypeOf(inst);
  return sentinel in proto ? undefined : proto;
}
var installing;
var broke = false;
var breaker = {
  configurable: true,
  get() {
    broke = true;
    return;
  }
};
function defineLazyInternal(inst, key, compute) {
  const proto = Object.getPrototypeOf(inst._zod);
  if (key in proto && installing !== inst._zod) {
    installing = undefined;
    return;
  }
  installing = inst._zod;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      Object.defineProperty(this, key, breaker);
      const outer = broke;
      broke = false;
      try {
        const value = compute(this);
        if (broke)
          delete this[key];
        else
          Object.defineProperty(this, key, { configurable: true, writable: true, value });
        broke = broke || outer;
        return value;
      } catch (err) {
        delete this[key];
        broke = broke || outer;
        throw err;
      }
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, value });
    }
  });
}
function installLazyProp(inst, key, make, enumerable) {
  const proto = claim(inst, key);
  if (!proto)
    return;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      const desc = { configurable: true, writable: true, enumerable, value: undefined };
      Object.defineProperty(this, key, desc);
      desc.value = make(this);
      Object.defineProperty(this, key, desc);
      return desc.value;
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, enumerable, value });
    }
  });
}
var CONSTANT_CATCH = "~constantCatch";
function constantCatch(value) {
  const fn = () => value;
  fn[CONSTANT_CATCH] = true;
  return fn;
}

// node_modules/zod/v4/core/core.js
var _a;
var _zodDesc = { value: undefined, enumerable: false };
var _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
  const E = _E;
  if (E) {
    const saved = E.stackTraceLimit;
    if (typeof saved === "number") {
      try {
        E.stackTraceLimit = 0;
      } catch {
        _E = null;
        return new Definition;
      }
      try {
        return new Definition;
      } finally {
        E.stackTraceLimit = saved;
      }
    }
  }
  return new Definition;
}
function $constructor(name, initializer, proto, params) {
  const zodProto = {};
  function Internals(def) {
    this.def = def;
    this.constr = _;
    this.traits = new Set;
  }
  Internals.prototype = zodProto;
  const protoMembers = proto;
  const initialized = protoMembers && new WeakSet;
  function init(inst, def) {
    if (!inst._zod) {
      _zodDesc.value = new Internals(def);
      try {
        Object.defineProperty(inst, "_zod", _zodDesc);
      } finally {
        _zodDesc.value = undefined;
      }
    } else if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer(inst, def);
    if (initialized) {
      const own = Object.getPrototypeOf(inst);
      const ctorProto = inst._zod.constr.prototype;
      let up = own;
      while (up && up !== ctorProto)
        up = Object.getPrototypeOf(up);
      const target = up ?? own;
      if (!initialized.has(target)) {
        initialized.add(target);
        members(target, protoMembers);
      }
    }
    const proto = _.prototype;
    for (const k in proto) {
      if (!Object.prototype.hasOwnProperty.call(proto, k))
        continue;
      if (!(k in inst)) {
        inst[k] = proto[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;

  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    const inst = params?.Parent ? newError(Definition) : this;
    init(inst, def);
    const deferred = inst._zod.deferred;
    if (deferred) {
      for (const fn of deferred) {
        fn();
      }
      inst._zod.deferred = undefined;
    }
    const pp = globalThis.__zod_globalConfig?.postProcessor;
    if (pp)
      pp(inst);
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
class $ZodAsyncError extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
}

class $ZodEncodeError extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
}
(_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}
// node_modules/zod/v4/core/errors.js
function _getMessage() {
  const internals = this._zod;
  internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
  return internals.message;
}
function _setMessage(value) {
  this._zod.message = value;
}
var _messageDesc = {
  get: _getMessage,
  set: _setMessage,
  enumerable: true,
  configurable: true
};
var _issuesDesc = { value: undefined, enumerable: false };
var _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  _issuesDesc.value = def;
  Object.defineProperty(inst, "issues", _issuesDesc);
  _issuesDesc.value = undefined;
  Object.defineProperty(inst, "message", _messageDesc);
  const proto = Object.getPrototypeOf(inst);
  if (!_installedToString.has(proto)) {
    _installedToString.add(proto);
    Object.defineProperty(proto, "toString", {
      configurable: true,
      enumerable: false,
      get() {
        const value = () => this.message;
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
        return value;
      },
      set(value) {
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
      }
    });
  }
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, undefined, {
  Parent: Error
});
function node(obj, key, make) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    if (key === "__proto__") {
      Object.defineProperty(obj, key, { value: make(), writable: true, enumerable: true, configurable: true });
    } else {
      obj[key] = make();
    }
  }
  return obj[key];
}
function flattenError(error, mapper = (issue) => issue.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error.issues) {
    if (sub.path.length > 0) {
      node(fieldErrors, sub.path[0], () => []).push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error, mapper = (issue) => issue.message) {
  const fieldErrors = { _errors: [] };
  const processError = (error, path = []) => {
    for (const issue of error.issues) {
      if (issue.code === "invalid_union" && issue.errors.length) {
        issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
      } else if (issue.code === "invalid_key") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else if (issue.code === "invalid_element") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else {
        const fullpath = [...path, ...issue.path];
        if (fullpath.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < fullpath.length) {
            const el = fullpath[i];
            const terminal = i === fullpath.length - 1;
            if (el === "_errors") {
              if (terminal)
                curr._errors.push(mapper(issue));
              i++;
              continue;
            }
            if (!Object.prototype.hasOwnProperty.call(curr, el)) {
              Object.defineProperty(curr, el, {
                value: { _errors: [] },
                enumerable: true,
                writable: true,
                configurable: true
              });
            }
            const node = curr[el];
            if (terminal) {
              node._errors.push(mapper(issue));
            }
            curr = node;
            i++;
          }
        }
      }
    }
  };
  processError(error);
  return fieldErrors;
}

// node_modules/zod/v4/core/parse.js
function finalizeParams(callee, params) {
  return { callee: params?.callee ?? callee, Err: params?.Err };
}
var _parse = (_Err) => {
  const fn = (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
    const result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise) {
      throw new $ZodAsyncError;
    }
    if (result.issues.length) {
      const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, _params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var _parseAsync = (_Err) => {
  const fn = async (schema, value, _ctx, params) => {
    const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
    let result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise)
      result = await result;
    if (result.issues.length) {
      const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
};
function failure(Err, issues, ctx) {
  let error;
  return {
    success: false,
    get error() {
      if (!error) {
        error = new Err(issues.map((iss) => finalizeIssue(iss, ctx, config())));
        issues = undefined;
        ctx = undefined;
      }
      return error;
    },
    set error(e) {
      error = e;
      issues = undefined;
      ctx = undefined;
    }
  };
}
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
};
var COMPILE_INVALID = /* @__PURE__ */ Symbol.for("zod.compile.invalid");
var COMPILE_FALLBACK = /* @__PURE__ */ Symbol.for("zod.compile.fallback");
var validate = (schema, value, _ctx) => {
  const validator = schema._zod.bag.validator;
  if (validator !== undefined) {
    if (validator(value) !== COMPILE_INVALID)
      return true;
    if (validator.definite === true && _ctx === undefined)
      return false;
  }
  return validateFallback(schema, value, _ctx);
};
function validateFallback(schema, value, _ctx) {
  const ctx = _ctx ? { ..._ctx, async: false, abortEarly: true } : { async: false, abortEarly: true };
  const fallbackRun = schema._zod.bag.fallbackRun;
  let result;
  if (fallbackRun) {
    ctx[COMPILE_FALLBACK] = true;
    result = fallbackRun({ value, issues: [] }, ctx);
  } else {
    result = schema._zod.run({ value, issues: [] }, ctx);
  }
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length === 0;
}
var validateAsync = async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true, abortEarly: true } : { async: true, abortEarly: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length === 0;
};
var _encode = (_Err) => {
  const parse = _parse(_Err);
  const fn = (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
    return parse(schema, value, ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _decode = (_Err) => {
  const parse = _parse(_Err);
  const fn = (schema, value, _ctx, _params) => {
    return parse(schema, value, _ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _encodeAsync = (_Err) => {
  const parseAsync = _parseAsync(_Err);
  const fn = async (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
    return await parseAsync(schema, value, ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _decodeAsync = (_Err) => {
  const parseAsync = _parseAsync(_Err);
  const fn = async (schema, value, _ctx, _params) => {
    return await parseAsync(schema, value, _ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
// node_modules/zod/v4/core/regexes.js
var cuid = /^[cC][0-9a-z]{6,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
function nanoidOfLength(length) {
  return new RegExp(`^[a-zA-Z0-9_-]{${length}}$`);
}
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version) => {
  if (!version)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var email = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var _emoji = `^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;
var httpProtocol = /^https?$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
function anchor(source) {
  return new RegExp(`^${source}$`);
}
var date = /* @__PURE__ */ anchor(dateSource);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : args.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const opts = ["Z"];
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const qualified = `${timeSource({ precision: args.precision, seconds: true })}(?:${opts.join("|")})`;
  const timeRegex = args.local ? `${qualified}|${timeSource({ precision: args.precision })}` : qualified;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var anyString = /^[\s\S]{0,}$/;
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;
var _null = /^null$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;

// node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a = inst._zod).onattach ?? (_a.onattach = []);
});
var _whenHasLength = (payload) => {
  const val = payload.value;
  return !nullish(val) && val.length !== undefined;
};
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_big",
      maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? def.value !== BigInt(0) && payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units > def.maximum ? codePointLength(input) : units;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units >= def.minimum && units < def.minimum * 2 ? codePointLength(input) : units;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units >= def.length && units <= def.length * 2 ? codePointLength(input) : units;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a, _b;
  $ZodCheck.init(inst, def);
  if (def.pattern)
    (_a = inst._zod).check ?? (_a.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position},}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// node_modules/zod/v4/core/doc.js
class Doc {
  constructor(args = [], closed = {}) {
    this.content = [];
    this.indent = 0;
    this.args = args;
    this.closed = closed;
  }
  indented(fn) {
    this.indent += 1;
    try {
      fn(this);
    } finally {
      this.indent -= 1;
    }
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split(`
`).filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const content = this?.content ?? [``];
    const factory = new F(...Object.keys(this.closed), `return function (${this.args.join(", ")}) {
${content.join(`
`)}
};`);
    return factory(...Object.values(this.closed));
  }
}

// node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 6,
  patch: 7
};

// node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const defChecks = inst._zod.def.checks;
  const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks, ctx) => {
      if (payload.memo)
        return payload;
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks) {
        if (ch._zod.def.when) {
          if (explicitlyAborted(payload))
            continue;
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError;
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            attachSchema(payload.issues, currLen, inst);
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          attachSchema(payload.issues, currLen, inst);
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary) => {
            return handleCanaryResult(canary, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return result.then((result) => runChecks(result, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
}, {
  get "~standard"() {
    return hide(this, "~standard", standardProps(this));
  },
  set "~standard"(value) {
    own(this, "~standard", value);
  }
});
var toStandardResult = (r, ctx) => r.issues.length ? { issues: r.issues.map((iss) => finalizeIssue(iss, ctx, config())) } : { value: r.value };
async function validateAsync2(inst, value) {
  const ctx = { async: true };
  return toStandardResult(await inst._zod.run({ value, issues: [] }, ctx), ctx);
}
function standardProps(inst) {
  return {
    validate: (value) => {
      const ctx = { async: false };
      try {
        const r = inst._zod.run({ value, issues: [] }, ctx);
        if (!(r instanceof Promise))
          return toStandardResult(r, ctx);
      } catch (_) {}
      return validateAsync2(inst, value);
    },
    vendor: "zod",
    version: 1
  };
}
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = def.pattern ?? anyString;
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_) {}
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === undefined)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var URL_BAD_FORMAT = 1;
var URL_UNPARSEABLE = 2;
function canParseURL(input) {
  try {
    if (typeof URL !== "undefined" && typeof URL.canParse === "function")
      return URL.canParse(input);
    new URL(input);
    return true;
  } catch {
    return false;
  }
}
function validateURL(trimmed, def) {
  if (!("normalize" in def) && !("hostname" in def) && !("protocol" in def)) {
    return canParseURL(trimmed) || URL_UNPARSEABLE;
  }
  return parseURLObject(trimmed, def);
}
function parseURLObject(trimmed, def) {
  if (!def.normalize && def.protocol?.source === httpProtocol.source && !/^https?:\/\//i.test(trimmed)) {
    return URL_BAD_FORMAT;
  }
  try {
    if (typeof URL !== "undefined") {
      const URLStatic = URL;
      if (typeof URLStatic.parse === "function")
        return URLStatic.parse(trimmed) ?? URL_UNPARSEABLE;
    }
    return new URL(trimmed);
  } catch {
    return URL_UNPARSEABLE;
  }
}
var asciiTabOrNewline = /[\t\n\r]/g;
function stripTabAndNewline(value) {
  return value.replace(asciiTabOrNewline, "");
}
function urlHostnameOk(url, hostname) {
  hostname.lastIndex = 0;
  return hostname.test(url.hostname);
}
function urlProtocolOk(url, protocol) {
  protocol.lastIndex = 0;
  return protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol);
}
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      const url = validateURL(trimmed, def);
      if (url === URL_BAD_FORMAT) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid URL format",
          input: payload.value,
          inst,
          continue: !def.abort
        });
        return;
      }
      if (url === URL_UNPARSEABLE) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          input: payload.value,
          inst,
          continue: !def.abort
        });
        return;
      }
      if (url === true) {
        payload.value = stripTabAndNewline(trimmed);
        return;
      }
      if (def.hostname && !urlHostnameOk(url, def.hostname)) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid hostname",
          pattern: def.hostname.source,
          input: payload.value,
          inst,
          continue: !def.abort
        });
      }
      if (def.protocol && !urlProtocolOk(url, def.protocol)) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid protocol",
          pattern: def.protocol.source,
          input: payload.value,
          inst,
          continue: !def.abort
        });
      }
      payload.value = def.normalize ? url.href : stripTabAndNewline(trimmed);
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  if (def.length !== undefined && (!Number.isInteger(def.length) || def.length < 1))
    throw new Error(`Invalid nanoid length: ${def.length}`);
  def.pattern ?? (def.pattern = def.length === undefined ? nanoid : nanoidOfLength(def.length));
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
});
var ipv6Alphabet = /^[0-9a-fA-F:.]+$/;
function isValidIPv6(value) {
  if (!ipv6Alphabet.test(value))
    return false;
  return canParseURL(`http://[${value}]`);
}
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (!isValidIPv6(payload.value)) {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
function isValidCIDRv6(value) {
  const parts = value.split("/");
  if (parts.length !== 2)
    return false;
  const [address, prefix] = parts;
  if (!prefix)
    return false;
  const prefixNum = Number(prefix);
  if (`${prefixNum}` !== prefix)
    return false;
  if (prefixNum < 0 || prefixNum > 128)
    return false;
  return isValidIPv6(address);
}
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (!isValidCIDRv6(payload.value)) {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (/\s/.test(data))
    return false;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var base64Charset = /^[0-9a-zA-Z+/]*={0,2}$/;
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64Charset);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var base64urlCharset = /^[A-Za-z0-9_-]*$/;
function isValidBase64URL(data) {
  if (!base64urlCharset.test(data))
    return false;
  const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64urlCharset);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : undefined : undefined;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _null;
  inst._zod.values = new Set([null]);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input === null)
      return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
function capSize(inst, size) {
  const caps = sizeCaps(inst._zod.def.checks);
  if (!caps.length)
    return;
  const cap = Math.min(...caps.map((c) => c[0]));
  const parse = inst._zod.parse;
  inst._zod.parse = (payload, ctx) => {
    const n = size(payload.value);
    if (n > cap && !ctx?.skipChecks && ctx?.direction !== "backward") {
      for (const [max, ch] of sizeCaps(inst._zod.def.checks)) {
        if (n > max && ch._zod.def.when(payload)) {
          const start = payload.issues.length;
          ch._zod.check(payload);
          payload.issues[start].continue = false;
          attachSchema(payload.issues, start, inst);
          return payload;
        }
      }
    }
    return parse(payload, ctx);
  };
}
var arraySize = (input) => Array.isArray(input) ? input.length : -1;
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
    const proms = [];
    const abortEarly = ctx?.abortEarly;
    for (let i = 0;i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result) => handleArrayResult(result, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
        if (abortEarly && result.issues.length !== 0 && aborted(result))
          break;
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
  capSize(inst, arraySize);
});
function handlePropertyResult(result, final, key, input, optin, optout) {
  const isPresent = key in input;
  const isOptionalOut = optout === "optional";
  if (!isPresent && isOptionalOut && optin === "optional") {
    return;
  }
  if (result.issues.length) {
    if (optin !== undefined && isOptionalOut && !isPresent) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!isPresent && optin === undefined) {
    if (!result.issues.length) {
      final.issues.push({
        code: "invalid_type",
        expected: "nonoptional",
        input: undefined,
        path: [key]
      });
    }
    return;
  }
  if (result.value === undefined) {
    if (isPresent || optin === "defaulted" && !isOptionalOut) {
      final.value[key] = undefined;
    }
  } else {
    final.value[key] = result.value;
  }
}
var NO_SYMBOL_KEYS = [];
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  const ownSymbols = Object.getOwnPropertySymbols(def.shape);
  const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
  const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
  for (const k of allKeys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    allKeys,
    symbolKeys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst, abortEarly) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  const optin = _catchall.optin;
  const optout = _catchall.optout;
  let seen = 0;
  for (const key in input) {
    if (abortEarly && payload.issues.length !== seen) {
      if (aborted(payload, seen))
        break;
      seen = payload.issues.length;
    }
    if (keySet.has(key))
      continue;
    if (key === "__proto__") {
      if (t === "never")
        unrecognized.push(key);
      continue;
    }
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
    } else {
      handlePropertyResult(r, payload, key, input, optin, optout);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst,
      continue: true
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  const sh = desc?.get ? desc.get.raw : def.shape ?? {};
  if (sh) {
    const get = () => {
      const newSh = { ...sh };
      Object.defineProperty(def, "shape", { value: newSh });
      get.raw = newSh;
      return newSh;
    };
    get.raw = sh;
    Object.defineProperty(def, "shape", { get });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazyInternal(inst, "propValues", (zod) => {
    const shape = zod.def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        if (!Object.prototype.hasOwnProperty.call(propValues, key)) {
          assignProp(propValues, key, new Set);
        }
        for (const v of field.values)
          propValues[key].add(v);
        if (field.optin !== undefined)
          propValues[key].add(undefined);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
    const proms = [];
    const shape = value.shape;
    const abortEarly = ctx?.abortEarly;
    let seen = payload.issues.length;
    for (const key of value.allKeys) {
      if (abortEarly && payload.issues.length !== seen) {
        if (aborted(payload, seen))
          break;
        seen = payload.issues.length;
      }
      if (key === "__proto__")
        continue;
      const el = shape[key];
      const optin = el._zod.optin;
      const optout = el._zod.optout;
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
      } else {
        handlePropertyResult(r, payload, key, input, optin, optout);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst, abortEarly === true);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const memo = globalConfig.memoizer;
  const generateFastpass = (shape) => {
    const normalized = _normalized.value;
    const syms = normalized.symbolKeys;
    const doc = new Doc(["payload", "ctx"], { shape, inst, memo, syms });
    const parseStr = (k) => `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    const prefixStr = (id, k) => `
          let ${id}_ab = false;
          for (let i = 0; i < ${id}.issues.length; i++) {
            const iss = ${id}.issues[i];
            iss.path = iss.path ? [${k}, ...iss.path] : [${k}];
            payload.issues.push(iss);
            if (iss.continue !== true) ${id}_ab = true;
          }
          if (${id}_ab && ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }`;
    doc.write(`const input = payload.value;`);
    const ids = Object.create(null);
    let counter = 0;
    for (const key of normalized.allKeys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(memo ? `const newResult = memo.alloc(inst, payload, {}, ctx);` : `const newResult = {};`);
    for (const key of normalized.allKeys) {
      if (key === "__proto__")
        continue;
      const id = ids[key];
      const k = typeof key === "symbol" ? `syms[${syms.indexOf(key)}]` : esc(key);
      const isPresent = `${k} in input`;
      const schema = shape[key];
      const optin = schema?._zod?.optin;
      const isOptionalIn = optin !== undefined;
      const isOptionalOut = schema?._zod?.optout === "optional";
      doc.write(`const ${id} = ${parseStr(k)};`);
      if (isOptionalIn && isOptionalOut) {
        const assign = optin === "optional" ? `${id}_present` : `${id}.value !== undefined || ${id}_present`;
        doc.write(`
        const ${id}_present = ${isPresent};
        if (!${id}.issues.length || ${id}_present) {
          if (${id}.issues.length) {${prefixStr(id, k)}
          }

          if (${assign}) {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
      } else if (!isOptionalIn) {
        doc.write(`
        const ${id}_present = ${isPresent};
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
          if (ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }
        }

        if (${id}_present) {
          newResult[${k}] = ${id}.value;
        }

      `);
      } else {
        doc.write(`
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
      `);
        if (optin === "defaulted") {
          doc.write(`newResult[${k}] = ${id}.value;`);
        } else {
          doc.write(`
        if (${id}.value !== undefined || ${isPresent}) {
          newResult[${k}] = ${id}.value;
        }
      `);
        }
      }
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    return doc.compile();
  };
  let fastpass;
  const isObject2 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst, ctx?.abortEarly === true);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== undefined) ? "optional" : undefined);
  defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : undefined);
  defineLazyInternal(inst, "values", (zod) => {
    if (zod.def.options.every((o) => o._zod.values)) {
      return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    if (zod.def.options.every((o) => o._zod.pattern)) {
      const patterns = zod.def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return;
  });
  const first = def.options.length === 1 ? def.options[0]._zod.run : null;
  inst._zod.parse = (payload, ctx) => {
    if (first) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results) => {
      return handleUnionResults(results, payload, inst, ctx);
    });
  };
});
function discriminatorMap(def) {
  const map = new Map;
  for (const option of def.options) {
    const values = option._zod.propValues?.[def.discriminator];
    if (!values || values.size === 0)
      throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
    for (const value of values) {
      if (map.has(value)) {
        if (value !== undefined)
          throw new Error(`Duplicate discriminator value "${String(value)}"`);
        map.set(value, null);
      } else {
        map.set(value, option);
      }
    }
  }
  return map;
}
var $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
  def.inclusive = false;
  $ZodUnion.init(inst, def);
  const _super = inst._zod.parse;
  defineLazyInternal(inst, "propValues", (zod) => {
    const propValues = {};
    let undefinedCount = 0;
    for (const option of zod.def.options) {
      const pv = option._zod.propValues;
      if (!pv || Object.keys(pv).length === 0)
        throw new Error(`Invalid discriminated union option at index "${zod.def.options.indexOf(option)}"`);
      if (pv[zod.def.discriminator]?.has(undefined))
        undefinedCount++;
      for (const [k, v] of Object.entries(pv)) {
        if (!Object.prototype.hasOwnProperty.call(propValues, k)) {
          assignProp(propValues, k, new Set);
        }
        for (const val of v) {
          propValues[k].add(val);
        }
      }
    }
    if (!zod.def.unionFallback && undefinedCount > 1)
      propValues[zod.def.discriminator]?.delete(undefined);
    return propValues;
  });
  def.options.forEach((option, i) => {
    const propShape = rawShape(option._zod.def);
    if (propShape && !Object.prototype.hasOwnProperty.call(propShape, def.discriminator)) {
      throw new Error(`Invalid discriminated union option at index "${i}"`);
    }
  });
  const disc = cached(() => discriminatorMap(def));
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({
        code: "invalid_type",
        expected: "object",
        input,
        inst
      });
      return payload;
    }
    const value = input?.[def.discriminator];
    const opt = disc.value.get(value);
    if (opt && (value !== undefined || ctx.direction !== "backward")) {
      return opt._zod.run(payload, ctx);
    }
    if (def.unionFallback || ctx.direction === "backward") {
      return _super(payload, ctx);
    }
    payload.issues.push({
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: def.discriminator,
      options: Array.from(disc.value.keys()).filter((value) => disc.value.get(value) !== null),
      input,
      path: [def.discriminator],
      inst
    });
    return payload;
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left, right]) => {
        return handleIntersectionResults(payload, left, right);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    if (Object.prototype.hasOwnProperty.call(newObj, "__proto__"))
      delete newObj.__proto__;
    for (const key of sharedKeys) {
      if (key === "__proto__")
        continue;
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  const unrecKeys = new Map;
  let unrecIssue;
  const keyIssues = new Map;
  const collect = (iss, side) => {
    let keys;
    if (iss.code === "unrecognized_keys" && !iss.path?.length) {
      unrecIssue ?? (unrecIssue = iss);
      keys = iss.keys;
    } else if (iss.code === "invalid_key" && iss.origin === "record" && iss.path?.length === 1) {
      const k = String(iss.path[0]);
      if (!keyIssues.has(k))
        keyIssues.set(k, iss);
      keys = [k];
    } else {
      return false;
    }
    for (const k of keys) {
      if (!unrecKeys.has(k))
        unrecKeys.set(k, {});
      unrecKeys.get(k)[side] = true;
    }
    return true;
  };
  for (const iss of left.issues) {
    if (!collect(iss, "l"))
      result.issues.push(iss);
  }
  for (const iss of right.issues) {
    if (!collect(iss, "r"))
      result.issues.push(iss);
  }
  const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
  if (bothKeys.length) {
    const aggregated = unrecIssue ? bothKeys.filter((k) => unrecIssue.keys.includes(k)) : [];
    if (aggregated.length)
      result.issues.push({ ...unrecIssue, keys: aggregated });
    for (const k of bothKeys) {
      if (!aggregated.includes(k) && keyIssues.has(k))
        result.issues.push(keyIssues.get(k));
    }
  }
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    if (aborted(result))
      return result;
    throw new Error(`Unmergable intersection. Error path: ` + `${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodTuple = /* @__PURE__ */ $constructor("$ZodTuple", (inst, def) => {
  $ZodType.init(inst, def);
  const items = def.items;
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        input,
        inst,
        expected: "tuple",
        code: "invalid_type"
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, [], ctx) : [];
    const proms = [];
    const optinStart = getTupleOptStart(items, "optin");
    const optoutStart = getTupleOptStart(items, "optout");
    if (!def.rest) {
      if (input.length < optinStart) {
        payload.issues.push({
          code: "too_small",
          minimum: optinStart,
          inclusive: true,
          input,
          inst,
          origin: "array"
        });
        return payload;
      }
      if (input.length > items.length) {
        payload.issues.push({
          code: "too_big",
          maximum: items.length,
          inclusive: true,
          input,
          inst,
          origin: "array"
        });
      }
    }
    const itemResults = new Array(items.length);
    const abortEarly = def.rest ? ctx?.abortEarly : undefined;
    let itemAborted = false;
    for (let i = 0;i < items.length; i++) {
      const r = items[i]._zod.run({ value: input[i], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((rr) => {
          itemResults[i] = rr;
        }));
      } else {
        itemResults[i] = r;
        if (abortEarly && !itemAborted && r.issues.length)
          itemAborted = aborted(r);
      }
    }
    if (def.rest && !itemAborted) {
      let i = items.length - 1;
      const rest = input.slice(items.length);
      let seen = payload.issues.length;
      for (const el of rest) {
        if (abortEarly && payload.issues.length !== seen) {
          if (aborted(payload, seen))
            break;
          seen = payload.issues.length;
        }
        i++;
        const result = def.rest._zod.run({ value: el, issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((r) => handleTupleResult(r, payload, i)));
        } else {
          handleTupleResult(result, payload, i);
        }
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => handleTupleResults(itemResults, payload, items, input, optoutStart));
    }
    return handleTupleResults(itemResults, payload, items, input, optoutStart);
  };
});
function getTupleOptStart(items, key) {
  for (let i = items.length - 1;i >= 0; i--) {
    const omittable = key === "optin" ? items[i]._zod.optin !== undefined : items[i]._zod.optout === "optional";
    if (!omittable)
      return i + 1;
  }
  return 0;
}
function handleTupleResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
function handleTupleResults(itemResults, final, items, input, optoutStart) {
  for (let i = 0;i < items.length; i++) {
    const r = itemResults[i];
    const isPresent = i < input.length;
    if (!isPresent && i >= optoutStart && items[i]._zod.optin === "optional") {
      final.value.length = i;
      break;
    }
    if (r.issues.length) {
      if (!isPresent && i >= optoutStart) {
        final.value.length = i;
        break;
      }
      final.issues.push(...prefixIssues(i, r.issues));
    }
    final.value[i] = r.value;
  }
  for (let i = final.value.length - 1;i >= input.length; i--) {
    if (items[i]._zod.optout === "optional" && final.value[i] === undefined) {
      final.value.length = i;
    } else {
      break;
    }
  }
  return final;
}
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    const values = def.keyType._zod.values;
    if (values && !def.partial) {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      const recordKeys = new Set;
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          recordKeys.add(typeof key === "number" ? key.toString() : key);
          if (key === "__proto__")
            continue;
          const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
          if (keyResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (keyResult.issues.length) {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
            continue;
          }
          const outKey = keyResult.value;
          if (outKey === "__proto__")
            continue;
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result) => {
              if (result.issues.length) {
                payload.issues.push(...prefixIssues(key, result.issues));
              }
              payload.value[outKey] = result.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[outKey] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!recordKeys.has(key)) {
          if (def.mode === "loose") {
            if (key === "__proto__")
              continue;
            payload.value[key] = input[key];
          } else {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          }
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true
        });
      }
    } else {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      let unrecognized;
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        if (!Object.prototype.propertyIsEnumerable.call(input, key))
          continue;
        let keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        const checkNumericKey = typeof key === "string" && number.test(key) && keyResult.issues.length;
        if (checkNumericKey) {
          const retryResult = def.keyType._zod.run({ value: Number(key), issues: [] }, ctx);
          if (retryResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (retryResult.issues.length === 0) {
            keyResult = retryResult;
          }
        }
        if (keyResult.issues.length) {
          if (def.mode === "loose") {
            payload.value[key] = input[key];
          } else if (values) {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          } else {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
          }
          continue;
        }
        const outKey = keyResult.value;
        if (outKey === "__proto__")
          continue;
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result) => {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[outKey] = result.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[outKey] = result.value;
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true
        });
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  defineLazyInternal(inst, "pattern", (zod) => {
    const patternValues = getEnumValues(zod.def.entries).filter((k) => propertyKeyTypes.has(typeof k));
    return new RegExp(patternValues.length ? `^(${patternValues.map((o) => escapeRegex(o.toString())).join("|")})$` : "^[^\\s\\S]$");
  });
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  const values = new Set(def.values);
  inst._zod.values = values;
  defineLazyInternal(inst, "pattern", (zod) => {
    const vals = zod.def.values;
    return new RegExp(vals.length ? `^(${vals.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$` : "^[^\\s\\S]$");
  });
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  globalConfig.memoizer?.guard(inst);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output) => {
        payload.value = output;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError;
    }
    payload.value = _out;
    return payload;
  };
});
function handleOptionalResult(payload, result) {
  payload.value = result.issues.length ? undefined : result.value;
  return payload;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
  inst._zod.optout = "optional";
  defineLazyInternal(inst, "values", (zod) => {
    const values = zod.def.innerType._zod.values;
    return values ? new Set([...values, undefined]) : undefined;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === undefined) {
      if (def.innerType._zod.optin !== "defaulted")
        return payload;
      const result = def.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
      if (result instanceof Promise)
        return result.then((result) => handleOptionalResult(payload, result));
      return handleOptionalResult(payload, result);
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  defineLazyInternal(inst, "pattern", (zod) => zod.def.innerType._zod.pattern);
  inst._zod.parse = (payload, ctx) => {
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : undefined;
  });
  defineLazyInternal(inst, "values", (zod) => {
    return zod.def.innerType._zod.values ? new Set([...zod.def.innerType._zod.values, null]) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "defaulted";
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleDefaultResult(result, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === undefined) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "defaulted";
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => {
    const v = zod.def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== undefined)) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleNonOptionalResult(result, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === undefined) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
function handleCatchResult(payload, result, def, ctx) {
  if (!result.issues.length) {
    payload.value = result.value;
    if (result.memo)
      payload.memo = true;
    return payload;
  }
  payload.value = def.catchValue({
    ...result,
    value: payload.value,
    error: {
      issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
    },
    input: payload.value
  });
  return payload;
}
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleCatchResult(payload, result, def, ctx));
    }
    return handleCatchResult(payload, result, def, ctx);
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => zod.def.in._zod.values);
  defineLazyInternal(inst, "optin", (zod) => zod.def.in._zod.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.out._zod.optout);
  defineLazyInternal(inst, "propValues", (zod) => zod.def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right) => handlePipeResult(right, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left) => handlePipeResult(left, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.some((iss) => iss.code !== "unrecognized_keys")) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues }, ctx);
}
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "propValues", (zod) => zod.def.innerType._zod.propValues);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType?._zod?.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType?._zod?.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  if (!payload.memo)
    payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodLazy = /* @__PURE__ */ $constructor("$ZodLazy", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "innerType", () => {
    const d = def;
    if (!d._cachedInner)
      d._cachedInner = def.getter();
    return d._cachedInner;
  });
  defineLazyInternal(inst, "pattern", (zod) => zod.innerType?._zod?.pattern);
  defineLazyInternal(inst, "propValues", (zod) => zod.innerType?._zod?.propValues);
  defineLazyInternal(inst, "optin", (zod) => zod.innerType?._zod?.optin ?? undefined);
  defineLazyInternal(inst, "optout", (zod) => zod.innerType?._zod?.optout ?? undefined);
  inst._zod.parse = (payload, ctx) => {
    const inner = inst._zod.innerType;
    return inner._zod.run(payload, ctx);
  };
});
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r) => handleRefineResult(r, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      path: [...inst._zod.def.path ?? []],
      continue: !inst._zod.def.abort
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
// node_modules/zod/v4/core/memoizer.js
class $ZodCyclicError extends Error {
  constructor() {
    super(`Cannot parse a reference cycle that closes through a transform`);
    this.name = "ZodCyclicError";
  }
}
var STATE = "~memo";
var NO_ISSUES = [];
function isRef(value) {
  return value !== null && typeof value === "object";
}
function cloneIssues(issues) {
  return issues.map((iss) => iss.path ? { ...iss, path: iss.path.slice() } : { ...iss });
}
var recursive = /* @__PURE__ */ new WeakMap;
var NONE = 0;
var ASSUMED = 1;
var PROVEN = 2;
function isRecursive(inst, stack, resolve) {
  const cached = recursive.get(inst);
  if (cached !== undefined)
    return cached ? PROVEN : NONE;
  if (stack.has(inst))
    return PROVEN;
  stack.add(inst);
  let result = NONE;
  const check = (child) => {
    if (result !== PROVEN && child?._zod) {
      const answer = isRecursive(child, stack, resolve);
      if (answer > result)
        result = answer;
    }
  };
  const shape = (sh, spread) => {
    let answer = NONE;
    for (const key of Reflect.ownKeys(sh)) {
      const desc = Object.getOwnPropertyDescriptor(sh, key);
      if (spread && !desc.enumerable)
        continue;
      const child = desc.get ? ASSUMED : desc.value?._zod ? isRecursive(desc.value, stack, resolve) : NONE;
      if (child > answer)
        answer = child;
    }
    return answer;
  };
  const merge = (answer) => {
    if (answer > result)
      result = answer;
  };
  const def = inst._zod.def;
  const kind = def.type;
  switch (kind) {
    case "object": {
      const raw = rawShape(def);
      merge(raw ? shape(raw, true) : ASSUMED);
      check(def.catchall);
      break;
    }
    case "array":
      check(def.element);
      break;
    case "tuple":
      for (const el of def.items)
        check(el);
      check(def.rest);
      break;
    case "record":
    case "map":
      check(def.keyType);
      check(def.valueType);
      break;
    case "set":
      check(def.valueType);
      break;
    case "union":
      for (const el of def.options)
        check(el);
      break;
    case "intersection":
      check(def.left);
      check(def.right);
      break;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
    case "promise":
    case "success":
      check(def.innerType);
      break;
    case "pipe":
      check(def.in);
      check(def.out);
      break;
    case "function":
      check(def.input);
      check(def.output);
      break;
    case "lazy": {
      const inner = def._cachedInner ?? (resolve ? inst._zod.innerType : undefined);
      merge(inner ? isRecursive(inner, stack, false) : ASSUMED);
      break;
    }
    case "template_literal":
    case "string":
    case "number":
    case "int":
    case "boolean":
    case "bigint":
    case "symbol":
    case "undefined":
    case "null":
    case "void":
    case "never":
    case "any":
    case "unknown":
    case "date":
    case "nan":
    case "enum":
    case "literal":
    case "file":
    case "transform":
    case "custom":
      break;
    default: {
      for (const key in def) {
        const desc = Object.getOwnPropertyDescriptor(def, key);
        if (!desc || desc.get)
          continue;
        const value = desc.value;
        if (!value || typeof value !== "object")
          continue;
        if (value._zod)
          check(value);
        else if (Array.isArray(value))
          for (const el of value)
            check(el);
      }
    }
  }
  stack.delete(inst);
  return settle(inst, result);
}
function settle(inst, answer) {
  if (answer !== ASSUMED)
    recursive.set(inst, answer === PROVEN);
  return answer;
}
function bucketFor(state, inst) {
  let bucket = state.buckets.get(inst);
  if (!bucket) {
    bucket = new WeakMap;
    state.buckets.set(inst, bucket);
  }
  return bucket;
}
var handoff;
var open = [];
var memo = {
  alloc(_inst, payload, empty) {
    const bucket = handoff;
    if (!bucket)
      return empty;
    handoff = undefined;
    const entry = { value: empty, issues: null };
    bucket.set(payload.value, entry);
    open.push(entry);
    return empty;
  },
  guard(inst) {
    var _a;
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred.push(() => {
      const base = inst._zod.parse;
      const wrapped = (payload, ctx) => {
        if (ctx.direction !== "backward" && isBackEdge(ctx, payload.value))
          throw new $ZodCyclicError;
        return base(payload, ctx);
      };
      inst._zod.parse = wrapped;
      if (inst._zod.run === base)
        inst._zod.run = wrapped;
    });
  },
  attach(inst) {
    var _a;
    let isRecursiveInst;
    let rechecked = false;
    let lastCtx;
    let lastBucket;
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred.push(() => {
      const base = inst._zod.parse;
      const wrapped = (payload, ctx) => {
        if (isRecursiveInst === undefined) {
          const walked = isRecursive(inst, new Set, false);
          if (walked === NONE) {
            inst._zod.parse = base;
            if (inst._zod.run === wrapped)
              inst._zod.run = base;
            return base(payload, ctx);
          }
          if (walked === PROVEN || rechecked)
            isRecursiveInst = true;
          else
            rechecked = true;
        }
        const input = payload.value;
        if (!isRef(input))
          return base(payload, ctx);
        let state = ctx[STATE];
        if (!state) {
          state = { buckets: new WeakMap, backEdges: undefined };
          ctx[STATE] = state;
        }
        let bucket;
        if (lastCtx === ctx) {
          bucket = lastBucket;
        } else {
          bucket = bucketFor(state, inst);
          lastCtx = ctx;
          lastBucket = bucket;
        }
        const hit = bucket.get(input);
        if (hit) {
          payload.value = hit.value;
          if (hit.issues) {
            if (hit.issues.length)
              payload.issues.push(...cloneIssues(hit.issues));
          } else {
            payload.memo = true;
            state.backEdges ?? (state.backEdges = new WeakSet);
            state.backEdges.add(hit.value);
          }
          return payload;
        }
        handoff = bucket;
        const depth = open.length;
        const result = base(payload, ctx);
        handoff = undefined;
        const entry = open.length > depth ? open.pop() : undefined;
        if (result instanceof Promise) {
          return result.then((r) => {
            if (entry)
              entry.issues = r.issues.length ? cloneIssues(r.issues) : NO_ISSUES;
            return r;
          });
        }
        if (entry)
          entry.issues = result.issues.length ? cloneIssues(result.issues) : NO_ISSUES;
        return result;
      };
      inst._zod.parse = wrapped;
      if (inst._zod.run === base)
        inst._zod.run = wrapped;
    });
  }
};
function memoizer() {
  return memo;
}
function isBackEdge(ctx, value) {
  const backEdges = ctx[STATE]?.backEdges;
  return backEdges !== undefined && isRef(value) && backEdges.has(value);
}
// node_modules/zod/v4/locales/en.js
var error = () => {
  const Sizable = {
    string: { unit: "characters", verb: "to have" },
    file: { unit: "bytes", verb: "to have" },
    array: { unit: "items", verb: "to have" },
    set: { unit: "items", verb: "to have" },
    map: { unit: "entries", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    mac: "MAC address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    currency_code: "currency code",
    credit_card: "credit card number",
    iban: "IBAN",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  function getTypeName(type, input) {
    if (type === "number" && typeof input === "number" && !Number.isFinite(input)) {
      return String(input);
    }
    return TypeDictionary[type] ?? type;
  }
  return (issue) => {
    switch (issue.code) {
      case "invalid_type": {
        const expected = getTypeName(issue.expected);
        const receivedType = parsedType(issue.input);
        const received = getTypeName(receivedType, issue.input);
        return `Invalid input: expected ${expected}, received ${received}`;
      }
      case "invalid_value":
        if (issue.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue.values[0])}`;
        return `Invalid option: expected one of ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.exact ? "exactly " : issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Too big: expected ${issue.origin ?? "value"} to have ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Too big: expected ${issue.origin ?? "value"} to be ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.exact ? "exactly " : issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Too small: expected ${issue.origin} to have ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Too small: expected ${issue.origin} to be ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Invalid string: must start with "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Invalid string: must end with "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Invalid string: must include "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Invalid string: must match pattern ${_issue.pattern}`;
        return `Invalid ${FormatDictionary[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${issue.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${issue.origin}`;
      case "invalid_union":
        if (issue.options && Array.isArray(issue.options) && issue.options.length > 0) {
          const opts = issue.options.map((o) => `'${o}'`).join(" | ");
          return `Invalid discriminator value. Expected ${opts}`;
        }
        if (issue.inclusive === false) {
          return "Invalid input: more than one option matched";
        }
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${issue.origin}`;
      default:
        return `Invalid input`;
    }
  };
};
function en_default() {
  return {
    localeError: error()
  };
}
// node_modules/zod/v4/core/registries.js
var _a2;
class $ZodRegistry {
  constructor() {
    this._map = new WeakMap;
    this._idmap = new Map;
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = new WeakMap;
    this._idmap = new Map;
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : undefined;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
}
function registry() {
  return new $ZodRegistry;
}
(_a2 = globalThis).__zod_globalRegistry ?? (_a2.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;
// node_modules/zod/v4/core/api.js
function snapshotChecks(def) {
  if (def.checks)
    def.checks = [...def.checks];
  return def;
}
function _string(Class, params) {
  return new Class(snapshotChecks({ type: "string", ...normalizeParams(params) }));
}
function _email(Class, params) {
  return new Class({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _guid(Class, params) {
  return new Class({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuid(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuidv4(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
function _uuidv6(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
function _uuidv7(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
function _url(Class, params) {
  return new Class({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _emoji2(Class, params) {
  return new Class({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _nanoid(Class, params) {
  return new Class({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid(Class, params) {
  return new Class({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid2(Class, params) {
  return new Class({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ulid(Class, params) {
  return new Class({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _xid(Class, params) {
  return new Class({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ksuid(Class, params) {
  return new Class({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv4(Class, params) {
  return new Class({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv6(Class, params) {
  return new Class({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv4(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv6(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64(Class, params) {
  return new Class({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64url(Class, params) {
  return new Class({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _e164(Class, params) {
  return new Class({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _jwt(Class, params) {
  return new Class({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _isoDateTime(Class, params) {
  return new Class({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDate(Class, params) {
  return new Class({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _isoTime(Class, params) {
  return new Class({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDuration(Class, params) {
  return new Class({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _number(Class, params) {
  return new Class(snapshotChecks({ type: "number", checks: [], ...normalizeParams(params) }));
}
function _int(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params)
  });
}
function _null2(Class, params) {
  return new Class({
    type: "null",
    ...normalizeParams(params)
  });
}
function _unknown(Class) {
  return new Class({
    type: "unknown"
  });
}
function _never(Class, params) {
  return new Class({
    type: "never",
    ...normalizeParams(params)
  });
}
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
function _normalize(form) {
  return _overwrite((input) => input.normalize(form));
}
function _trim() {
  return _overwrite((input) => input.trim());
}
function _toLowerCase() {
  return _overwrite((input) => input.toLowerCase());
}
function _toUpperCase() {
  return _overwrite((input) => input.toUpperCase());
}
function _slugify() {
  return _overwrite((input) => slugify(input));
}
function _array(Class, element, params) {
  return new Class({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
function _refine(Class, fn, _params) {
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
function _superRefine(fn, params) {
  const ch = _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        if (!("input" in _issue))
          _issue.input = payload.value;
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  }, params);
  return ch;
}
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
// node_modules/zod/v4/core/to-json-schema.js
function assignProps(target, ...sources) {
  for (const source of sources) {
    for (const key of Reflect.ownKeys(source)) {
      if (Object.prototype.propertyIsEnumerable.call(source, key)) {
        assignProp(target, key, source[key]);
      }
    }
  }
  return target;
}
function initializeContext(params) {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4")
    target = "draft-04";
  if (target === "draft-7")
    target = "draft-07";
  return {
    processors: params.processors ?? {},
    metadataRegistry: params?.metadata ?? globalRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    override: params?.override ?? (() => {}),
    io: params?.io ?? "output",
    counter: 0,
    seen: new Map,
    sharedDefsExtractedFor: undefined,
    sharedEmitDoneFor: undefined,
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    intersections: [],
    deferred: [],
    external: params?.external ?? undefined
  };
}
function handleUnrepresentable(schema, ctx, json, params, message) {
  const result = typeof ctx.unrepresentable === "function" ? ctx.unrepresentable({ zodSchema: schema, path: params.path, message }) : ctx.unrepresentable;
  if (result === "any")
    return false;
  if (result === undefined || result === "throw")
    throw new Error(message);
  Object.assign(json, result);
  return true;
}
function processSchema(schema, ctx, _params = { path: [], schemaPath: [] }) {
  var _a;
  const def = schema._zod.def;
  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    const isCycle = _params.schemaPath.includes(schema);
    if (isCycle) {
      seen.cycle = _params.path;
    }
    return seen.schema;
  }
  const result = { schema: {}, count: 1, cycle: undefined, path: _params.path };
  ctx.seen.set(schema, result);
  ctx.sharedDefsExtractedFor = undefined;
  ctx.sharedEmitDoneFor = undefined;
  const overrideSchema = schema._zod.toJSONSchema?.();
  if (overrideSchema) {
    result.schema = overrideSchema;
  } else {
    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path
    };
    if (schema._zod.processJSONSchema) {
      schema._zod.processJSONSchema(ctx, result.schema, params);
    } else {
      const _json = result.schema;
      const processor = ctx.processors[def.type];
      if (!processor) {
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
      }
      processor(schema, ctx, _json, params);
    }
    const parent = schema._zod.parent;
    if (parent) {
      if (!result.ref)
        result.ref = parent;
      processSchema(parent, ctx, params);
      ctx.seen.get(parent).isParent = true;
    }
  }
  const meta = ctx.metadataRegistry.get(schema);
  if (meta)
    assignProps(result.schema, meta);
  if (ctx.io === "input" && isTransforming(schema)) {
    delete result.schema.examples;
    delete result.schema.default;
  }
  if (ctx.io === "input" && "_prefault" in result.schema)
    (_a = result.schema).default ?? (_a.default = result.schema._prefault);
  delete result.schema._prefault;
  const _result = ctx.seen.get(schema);
  return _result.schema;
}
function encodeJSONPointerSegment(segment) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
function extractDefs(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  if (ctx.external && ctx.sharedDefsExtractedFor === ctx.external)
    return;
  const idToSchema = new Map;
  for (const entry of ctx.seen.entries()) {
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry[0]) {
        throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      }
      idToSchema.set(id, entry[0]);
    }
  }
  const makeURI = (entry) => {
    const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id) => id);
      if (externalId) {
        return { ref: uriGenerator(externalId) };
      }
      const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${encodeJSONPointerSegment(id)}` };
    }
    const uriPrefix = `#`;
    const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
    if (entry[1] === root && !entry[1].schema.id) {
      return { ref: uriPrefix };
    }
    const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
    return { defId, ref: defUriPrefix + encodeJSONPointerSegment(defId) };
  };
  const extractToDef = (entry) => {
    if (entry[1].schema.$ref) {
      return;
    }
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId)
      seen.defId = defId;
    const schema = seen.schema;
    for (const key in schema) {
      delete schema[key];
    }
    schema.$ref = ref;
  };
  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle) {
        throw new Error("Cycle detected: " + `#/${seen.cycle?.join("/")}/<root>` + '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.');
      }
    }
  }
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) {
      extractToDef(entry);
      continue;
    }
    if (ctx.external) {
      const ext = ctx.external.registry.get(entry[0])?.id;
      if (schema !== entry[0] && ext) {
        extractToDef(entry);
        continue;
      }
    }
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      extractToDef(entry);
      continue;
    }
    if (seen.cycle) {
      extractToDef(entry);
      continue;
    }
    if (seen.count > 1) {
      if (ctx.reused === "ref") {
        extractToDef(entry);
      }
    }
  }
  if (ctx.external)
    ctx.sharedDefsExtractedFor = ctx.external;
}
function compactTypeUnion(schema) {
  const options = schema.anyOf;
  if (!Array.isArray(options) || options.length === 0 || schema.type !== undefined)
    return;
  const types = [];
  for (const option of options) {
    if (!option || typeof option !== "object")
      return;
    compactTypeUnion(option);
    const keys = Object.keys(option);
    if (keys.length !== 1 || keys[0] !== "type")
      return;
    const type = option.type;
    for (const member of Array.isArray(type) ? type : [type]) {
      if (typeof member !== "string")
        return;
      if (!types.includes(member))
        types.push(member);
    }
  }
  delete schema.anyOf;
  schema.type = types.length === 1 ? types[0] : types;
}
var FOLDABLE_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
var UNION_KEYS = ["oneOf", "anyOf"];
function undeclaredConstraint(member) {
  const extra = member.additionalProperties;
  if (extra === undefined || extra === false || typeof extra !== "object" || extra === null)
    return null;
  return Object.keys(extra).length ? extra : null;
}
function foldObjects(members) {
  const objects = [];
  for (const member of members) {
    if (typeof member !== "object" || member.type !== "object")
      return null;
    for (const key in member) {
      if (!FOLDABLE_KEYS.has(key))
        return null;
    }
    objects.push(member);
  }
  const properties = {};
  const required = new Set;
  for (const object of objects) {
    for (const key in object.properties) {
      if (Object.prototype.hasOwnProperty.call(properties, key))
        continue;
      const parts = [];
      for (const other of objects) {
        const part = other.properties?.[key] ?? undeclaredConstraint(other);
        if (part === null || part === undefined)
          continue;
        if (!parts.some((seen) => JSON.stringify(seen) === JSON.stringify(part)))
          parts.push(part);
      }
      const merged = parts.length === 1 ? parts[0] : foldObjects(parts) ?? { allOf: parts };
      assignProp(properties, key, merged);
    }
    for (const key of object.required ?? [])
      required.add(key);
  }
  const folded = { type: "object", properties };
  if (required.size)
    folded.required = [...required];
  if (objects.every((object) => object.additionalProperties === false)) {
    folded.additionalProperties = false;
  } else {
    const constraints = [];
    for (const object of objects) {
      const constraint = undeclaredConstraint(object);
      if (constraint && !constraints.some((seen) => JSON.stringify(seen) === JSON.stringify(constraint)))
        constraints.push(constraint);
    }
    if (constraints.length === 1)
      folded.additionalProperties = constraints[0];
    else if (constraints.length > 1)
      folded.additionalProperties = { allOf: constraints };
  }
  return folded;
}
function foldIntersection(json) {
  const allOf = json.allOf;
  if (!Array.isArray(allOf) || allOf.length < 2)
    return;
  for (const key of FOLDABLE_KEYS)
    if (key in json)
      return;
  const unions = allOf.filter((m) => UNION_KEYS.some((k) => Array.isArray(m[k])));
  let folded = null;
  if (!unions.length) {
    folded = foldObjects(allOf);
  } else {
    const union = unions[0];
    const keyword = UNION_KEYS.find((k) => Array.isArray(union[k]));
    if (Object.keys(union).length !== 1)
      return;
    const rest = allOf.filter((m) => m !== union);
    const branches = union[keyword].map((branch) => foldObjects([...rest, branch]));
    if (branches.some((b) => !b))
      return;
    folded = { [keyword]: branches };
  }
  if (!folded)
    return;
  delete json.allOf;
  assignProps(json, folded);
}
function finalize(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const flattenRef = (zodSchema) => {
    const seen = ctx.seen.get(zodSchema);
    if (seen.ref === null)
      return;
    const schema = seen.def ?? seen.schema;
    const _cached = { ...schema };
    const ref = seen.ref;
    seen.ref = null;
    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref);
      const refSchema = refSeen.schema;
      if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
        schema.allOf = schema.allOf ?? [];
        schema.allOf.push(refSchema);
      } else {
        assignProps(schema, refSchema);
      }
      assignProps(schema, _cached);
      const isParentRef = zodSchema._zod.parent === ref;
      if (isParentRef) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (!(key in _cached)) {
            delete schema[key];
          }
        }
      }
      if (refSchema.$ref && refSeen.def) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) {
            delete schema[key];
          }
        }
      }
    }
    const parent = zodSchema._zod.parent;
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen?.schema.$ref) {
        schema.$ref = parentSeen.schema.$ref;
        if (parentSeen.def) {
          for (const key in schema) {
            if (key === "$ref" || key === "allOf")
              continue;
            if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) {
              delete schema[key];
            }
          }
        }
      }
    }
    ctx.override({
      zodSchema,
      jsonSchema: schema,
      path: seen.path ?? []
    });
  };
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of [...ctx.seen.entries()].reverse()) {
      flattenRef(entry[0]);
    }
    if (ctx.target !== "openapi-3.0") {
      for (const entry of ctx.seen.entries()) {
        compactTypeUnion(entry[1].def ?? entry[1].schema);
      }
    }
    for (const rewrite of ctx.deferred)
      rewrite();
    if (ctx.intersections.length) {
      const carriers = new Map;
      for (const seen of ctx.seen.values()) {
        for (const json of [seen.schema, seen.def]) {
          const allOf = json?.allOf;
          if (!Array.isArray(allOf))
            continue;
          const existing = carriers.get(allOf);
          if (existing)
            existing.push(json);
          else
            carriers.set(allOf, [json]);
        }
      }
      for (const allOf of ctx.intersections) {
        for (const json of carriers.get(allOf) ?? [])
          foldIntersection(json);
      }
    }
  }
  const result = {};
  if (ctx.target === "draft-2020-12") {
    result.$schema = "https://json-schema.org/draft/2020-12/schema";
  } else if (ctx.target === "draft-07") {
    result.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (ctx.target === "draft-04") {
    result.$schema = "http://json-schema.org/draft-04/schema#";
  } else if (ctx.target === "openapi-3.0") {}
  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id)
      throw new Error("Schema is missing an `id` property");
    result.$id = ctx.external.uri(id);
  }
  assignProps(result, root.defId ? root.schema : root.def ?? root.schema);
  const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
  if (rootMetaId !== undefined && result.id === rootMetaId)
    delete result.id;
  const defs = ctx.external?.defs ?? {};
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        if (seen.def.id === seen.defId)
          delete seen.def.id;
        assignProp(defs, seen.defId, seen.def);
      }
    }
  }
  if (ctx.external)
    ctx.sharedEmitDoneFor = ctx.external;
  if (ctx.external) {} else {
    if (Object.keys(defs).length > 0) {
      if (ctx.target === "draft-2020-12") {
        result.$defs = defs;
      } else {
        result.definitions = defs;
      }
    }
  }
  try {
    const finalized = JSON.parse(JSON.stringify(result));
    Object.defineProperty(finalized, "~standard", {
      value: {
        ...schema["~standard"],
        jsonSchema: {
          input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
          output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
        }
      },
      enumerable: false,
      writable: false
    });
    return finalized;
  } catch (_err) {
    throw new Error("Error converting schema to JSON.");
  }
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: new Set };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const def = _schema._zod.def;
  if (def.type === "transform")
    return true;
  if (def.type === "array")
    return isTransforming(def.element, ctx);
  if (def.type === "set")
    return isTransforming(def.valueType, ctx);
  if (def.type === "lazy")
    return isTransforming(def.getter(), ctx);
  if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault" || def.type === "catch") {
    return isTransforming(def.innerType, ctx);
  }
  if (def.type === "intersection") {
    return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
  }
  if (def.type === "record" || def.type === "map") {
    return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
  }
  if (def.type === "pipe") {
    if (_schema._zod.traits.has("$ZodCodec"))
      return true;
    return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
  }
  if (def.type === "object") {
    for (const key in def.shape) {
      if (isTransforming(def.shape[key], ctx))
        return true;
    }
    return false;
  }
  if (def.type === "union") {
    for (const option of def.options) {
      if (isTransforming(option, ctx))
        return true;
    }
    return false;
  }
  if (def.type === "tuple") {
    for (const item of def.items) {
      if (isTransforming(item, ctx))
        return true;
    }
    if (def.rest && isTransforming(def.rest, ctx))
      return true;
    return false;
  }
  return false;
}
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
  const ctx = initializeContext({ ...params, processors });
  processSchema(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
  const { libraryOptions, target } = params ?? {};
  const ctx = initializeContext({ ...libraryOptions ?? {}, target, io, processors });
  processSchema(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
// node_modules/zod/v4/core/json-schema-processors.js
var narrowMin = (agg, key, value) => {
  if (agg[key] === undefined || value > agg[key])
    agg[key] = value;
};
var narrowMax = (agg, key, value) => {
  if (agg[key] === undefined || value < agg[key])
    agg[key] = value;
};
var narrowBoth = (agg, value) => {
  narrowMin(agg, "minimum", value);
  narrowMax(agg, "maximum", value);
};
var addDivisor = (agg, value) => {
  agg.multipleOf ?? (agg.multipleOf = []);
  if (!agg.multipleOf.includes(value))
    agg.multipleOf.push(value);
};
var addPattern = (agg, pattern) => {
  agg.patterns ?? (agg.patterns = new Set);
  agg.patterns.add(pattern);
};
var intersectMime = (agg, mime) => {
  agg.mime = agg.mime ? agg.mime.filter((m) => mime.includes(m)) : [...mime];
};
var setFormat = (agg, format) => {
  agg.format = format;
  if (format.includes("int"))
    agg.isInt = true;
};
var minContributor = (agg, def) => narrowMin(agg, "minimum", def.minimum);
var maxContributor = (agg, def) => narrowMax(agg, "maximum", def.maximum);
var formatContributor = (ranges) => (agg, def) => {
  setFormat(agg, def.format);
  const [minimum, maximum] = ranges[def.format];
  narrowMin(agg, "minimum", minimum);
  narrowMax(agg, "maximum", maximum);
};
var contributors = {
  greater_than: (agg, def) => narrowMin(agg, def.inclusive ? "minimum" : "exclusiveMinimum", def.value),
  less_than: (agg, def) => narrowMax(agg, def.inclusive ? "maximum" : "exclusiveMaximum", def.value),
  multiple_of: (agg, def) => addDivisor(agg, def.value),
  number_format: formatContributor(NUMBER_FORMAT_RANGES),
  bigint_format: formatContributor(BIGINT_FORMAT_RANGES),
  min_length: minContributor,
  max_length: maxContributor,
  length_equals: (agg, def) => narrowBoth(agg, def.length),
  min_size: minContributor,
  max_size: maxContributor,
  size_equals: (agg, def) => narrowBoth(agg, def.size),
  string_format: (agg, def) => {
    setFormat(agg, def.format);
    if (def.pattern)
      addPattern(agg, def.pattern);
    if (def.format === "base64" || def.format === "base64url")
      agg.contentEncoding = def.format;
    if (def.local || def.precision === -1)
      agg.laxFormat = true;
  },
  mime_type: (agg, def) => intersectMime(agg, def.mime)
};
function aggregateChecks(schema) {
  const agg = {};
  const def = schema._zod.def;
  const list = schema._zod.traits.has("$ZodCheck") ? [schema, ...def.checks ?? []] : def.checks ?? [];
  for (const ch of list)
    contributors[ch._zod.def.check]?.(agg, ch._zod.def);
  const bag = schema._zod.bag;
  if (bag.minimum !== undefined)
    narrowMin(agg, "minimum", bag.minimum);
  if (bag.exclusiveMinimum !== undefined)
    narrowMin(agg, "exclusiveMinimum", bag.exclusiveMinimum);
  if (bag.maximum !== undefined)
    narrowMax(agg, "maximum", bag.maximum);
  if (bag.exclusiveMaximum !== undefined)
    narrowMax(agg, "exclusiveMaximum", bag.exclusiveMaximum);
  if (bag.multipleOf !== undefined)
    addDivisor(agg, bag.multipleOf);
  if (bag.format !== undefined) {
    agg.format ?? (agg.format = bag.format);
    if (bag.format.includes("int"))
      agg.isInt = true;
  }
  if (bag.mime)
    intersectMime(agg, bag.mime);
  for (const pattern of bag.patterns ?? [])
    addPattern(agg, pattern);
  return agg;
}
var formatMap = {
  guid: "uuid",
  url: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: ""
};
var exactPatterns = new Map([
  [base64Charset, base64],
  [base64urlCharset, base64url]
]);
var exactPattern = (p) => exactPatterns.get(p) ?? p;
var stringProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  json.type = "string";
  const { minimum, maximum, format, patterns, contentEncoding, laxFormat } = aggregateChecks(schema);
  if (typeof minimum === "number")
    json.minLength = minimum;
  if (typeof maximum === "number")
    json.maxLength = maximum;
  if (format) {
    json.format = formatMap[format] ?? format;
    if (json.format === "")
      delete json.format;
    if (format === "time" || laxFormat) {
      delete json.format;
    }
  }
  if (contentEncoding)
    json.contentEncoding = contentEncoding;
  if (patterns && patterns.size > 0) {
    const patternList = [...patterns].map(exactPattern);
    if (patternList.length === 1)
      json.pattern = patternList[0].source;
    else if (patternList.length > 1) {
      json.allOf = [
        ...patternList.map((regex) => ({
          ...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
          pattern: regex.source
        }))
      ];
    }
  }
};
var numberProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const { minimum, maximum, multipleOf, exclusiveMaximum, exclusiveMinimum, isInt } = aggregateChecks(schema);
  json.type = isInt ? "integer" : "number";
  const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
  const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
  const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
  if (exMin) {
    if (legacy) {
      json.minimum = exclusiveMinimum;
      json.exclusiveMinimum = true;
    } else {
      json.exclusiveMinimum = exclusiveMinimum;
    }
  } else if (typeof minimum === "number") {
    json.minimum = minimum;
  }
  if (exMax) {
    if (legacy) {
      json.maximum = exclusiveMaximum;
      json.exclusiveMaximum = true;
    } else {
      json.exclusiveMaximum = exclusiveMaximum;
    }
  } else if (typeof maximum === "number") {
    json.maximum = maximum;
  }
  if (multipleOf) {
    const divisors = new Set;
    for (const divisor of multipleOf) {
      if (Number.isFinite(divisor) && divisor !== 0)
        divisors.add(Math.abs(divisor));
      else
        handleUnrepresentable(schema, ctx, json, params, `A multipleOf divisor of ${divisor} cannot be represented in JSON Schema`);
    }
    const [first, ...rest] = divisors;
    if (first !== undefined)
      json.multipleOf = first;
    if (rest.length)
      json.allOf = [...json.allOf ?? [], ...rest.map((m) => ({ multipleOf: m }))];
  }
};
var booleanProcessor = (_schema, _ctx, json, _params) => {
  json.type = "boolean";
};
var bigintProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "BigInt cannot be represented in JSON Schema");
};
var symbolProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Symbols cannot be represented in JSON Schema");
};
var nullProcessor = (_schema, ctx, json, _params) => {
  if (ctx.target === "openapi-3.0") {
    json.type = "string";
    json.nullable = true;
    json.enum = [null];
  } else {
    json.type = "null";
  }
};
var undefinedProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Undefined cannot be represented in JSON Schema");
};
var voidProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Void cannot be represented in JSON Schema");
};
var neverProcessor = (_schema, _ctx, json, _params) => {
  json.not = {};
};
var anyProcessor = (_schema, _ctx, _json, _params) => {};
var unknownProcessor = (_schema, _ctx, _json, _params) => {};
var dateProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Date cannot be represented in JSON Schema");
};
var enumProcessor = (schema, _ctx, json, _params) => {
  const def = schema._zod.def;
  const values = getEnumValues(def.entries);
  if (values.length === 0) {
    json.not = {};
    return;
  }
  if (values.every((v) => typeof v === "number"))
    json.type = "number";
  if (values.every((v) => typeof v === "string"))
    json.type = "string";
  json.enum = values;
};
var literalProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  if (def.values.length === 0) {
    json.not = {};
    return;
  }
  const vals = [];
  for (const val of def.values) {
    if (val === undefined) {
      if (handleUnrepresentable(schema, ctx, json, params, "Literal `undefined` cannot be represented in JSON Schema"))
        return;
    } else if (typeof val === "bigint") {
      if (handleUnrepresentable(schema, ctx, json, params, "BigInt literals cannot be represented in JSON Schema"))
        return;
      vals.push(Number(val));
    } else {
      vals.push(val);
    }
  }
  if (vals.length === 0) {} else if (vals.length === 1) {
    const val = vals[0];
    json.type = val === null ? "null" : typeof val;
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json.enum = [val];
    } else {
      json.const = val;
    }
  } else {
    if (vals.every((v) => typeof v === "number"))
      json.type = "number";
    if (vals.every((v) => typeof v === "string"))
      json.type = "string";
    if (vals.every((v) => typeof v === "boolean"))
      json.type = "boolean";
    if (vals.every((v) => v === null))
      json.type = "null";
    json.enum = vals;
  }
};
var nanProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "NaN cannot be represented in JSON Schema");
};
var templateLiteralProcessor = (schema, _ctx, json, _params) => {
  const _json = json;
  const pattern = schema._zod.pattern;
  if (!pattern)
    throw new Error("Pattern not found in template literal");
  _json.type = "string";
  _json.pattern = pattern.source;
};
var fileProcessor = (schema, _ctx, json, _params) => {
  const _json = json;
  _json.type = "string";
  _json.format = "binary";
  _json.contentEncoding = "binary";
  const { minimum, maximum, mime } = aggregateChecks(schema);
  if (minimum !== undefined)
    _json.minLength = minimum;
  if (maximum !== undefined)
    _json.maxLength = maximum;
  if (!mime)
    return;
  if (mime.length === 0)
    _json.not = {};
  else if (mime.length === 1)
    _json.contentMediaType = mime[0];
  else
    _json.anyOf = mime.map((m) => ({ contentMediaType: m }));
};
var successProcessor = (_schema, _ctx, json, _params) => {
  json.type = "boolean";
};
var customProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Custom types cannot be represented in JSON Schema");
};
var functionProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Function types cannot be represented in JSON Schema");
};
var transformProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Transforms cannot be represented in JSON Schema");
};
var mapProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Map cannot be represented in JSON Schema");
};
var setProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Set cannot be represented in JSON Schema");
};
var arrayProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const { minimum, maximum } = aggregateChecks(schema);
  if (typeof minimum === "number")
    json.minItems = minimum;
  if (typeof maximum === "number")
    json.maxItems = maximum;
  json.type = "array";
  json.items = processSchema(def.element, ctx, {
    ...params,
    path: [...params.path, "items"]
  });
};
function inputOptin(schema) {
  const def = schema._zod.def;
  if (def.type === "pipe" && def.in._zod.traits.has("$ZodTransform")) {
    return inputOptin(def.out);
  }
  if (def.type === "catch") {
    return inputOptin(def.innerType);
  }
  return schema._zod.optin;
}
var objectProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const shape = def.shape;
  const symbolKeys = Object.getOwnPropertySymbols(shape);
  if (symbolKeys.length && handleUnrepresentable(schema, ctx, json, params, "Symbol keys cannot be represented in JSON Schema")) {
    return;
  }
  json.type = "object";
  json.properties = {};
  for (const key in shape) {
    assignProp(json.properties, key, processSchema(shape[key], ctx, {
      ...params,
      path: [...params.path, "properties", key]
    }));
  }
  const requiredKeys = [];
  for (const key of Object.keys(shape)) {
    const field = def.shape[key];
    if (ctx.io === "input" ? inputOptin(field) === undefined : field._zod.optout === undefined) {
      requiredKeys.push(key);
    }
  }
  if (requiredKeys.length > 0) {
    json.required = requiredKeys;
  }
  if (def.catchall?._zod.def.type === "never") {
    json.additionalProperties = false;
  } else if (!def.catchall) {
    if (ctx.io === "output")
      json.additionalProperties = false;
  } else if (def.catchall) {
    json.additionalProperties = processSchema(def.catchall, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
};
var unionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const isExclusive = def.inclusive === false;
  const options = def.options.map((x, i) => processSchema(x, ctx, {
    ...params,
    path: [...params.path, isExclusive ? "oneOf" : "anyOf", i]
  }));
  if (isExclusive) {
    json.oneOf = options;
  } else {
    json.anyOf = options;
  }
};
var intersectionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const a = processSchema(def.left, ctx, {
    ...params,
    path: [...params.path, "allOf", 0]
  });
  const b = processSchema(def.right, ctx, {
    ...params,
    path: [...params.path, "allOf", 1]
  });
  const isSimpleIntersection = (val) => ("allOf" in val) && Object.keys(val).length === 1;
  const allOf = [
    ...isSimpleIntersection(a) ? a.allOf : [a],
    ...isSimpleIntersection(b) ? b.allOf : [b]
  ];
  json.allOf = allOf;
  ctx.intersections.push(allOf);
};
var tupleProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "array";
  const prefixPath = ctx.target === "draft-2020-12" ? "prefixItems" : "items";
  const restPath = ctx.target === "draft-2020-12" ? "items" : ctx.target === "openapi-3.0" ? "items" : "additionalItems";
  const prefixItems = def.items.map((x, i) => processSchema(x, ctx, {
    ...params,
    path: [...params.path, prefixPath, i]
  }));
  const rest = def.rest ? processSchema(def.rest, ctx, {
    ...params,
    path: [...params.path, restPath, ...ctx.target === "openapi-3.0" ? [def.items.length] : []]
  }) : null;
  let minItems = def.items.length;
  while (minItems > 0) {
    const item = def.items[minItems - 1];
    const optional = ctx.io === "input" ? inputOptin(item) !== undefined : item._zod.optout === "optional";
    if (!optional)
      break;
    minItems--;
  }
  const maxItems = def.items.length;
  const isClosed = !def.rest;
  if (ctx.target === "draft-2020-12") {
    json.prefixItems = prefixItems;
    if (isClosed) {
      json.items = false;
    } else if (rest) {
      json.items = rest;
    }
    if (minItems > 0)
      json.minItems = minItems;
    if (isClosed)
      json.maxItems = maxItems;
  } else if (ctx.target === "openapi-3.0") {
    json.items = {
      anyOf: prefixItems
    };
    if (rest) {
      json.items.anyOf.push(rest);
    }
    if (minItems > 0)
      json.minItems = minItems;
    if (isClosed)
      json.maxItems = maxItems;
  } else {
    json.items = prefixItems;
    if (isClosed) {
      json.additionalItems = false;
    } else if (rest) {
      json.additionalItems = rest;
    }
    if (minItems > 0)
      json.minItems = minItems;
    if (isClosed)
      json.maxItems = maxItems;
  }
  const { minimum, maximum } = aggregateChecks(schema);
  if (typeof minimum === "number")
    json.minItems = minimum;
  if (typeof maximum === "number")
    json.maxItems = maximum;
};
function stringifyKeyNames(bySchema, json, visited) {
  if (json.$ref) {
    if (visited.has(json))
      return json;
    visited.add(json);
    const def = bySchema.get(json)?.def;
    if (!def)
      return json;
    const inlined = stringifyKeyNames(bySchema, def, visited);
    return inlined === def ? json : inlined;
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = json[keyword];
    if (!Array.isArray(branches))
      continue;
    const mapped = branches.map((branch) => stringifyKeyNames(bySchema, branch, visited));
    if (mapped.some((branch, i) => branch !== branches[i]))
      json = { ...json, [keyword]: mapped };
  }
  const types = Array.isArray(json.type) ? json.type : [json.type];
  const numericType = !types.includes("string") && types.some((t) => t === "number" || t === "integer");
  const values = json.enum ?? (json.const !== undefined ? [json.const] : undefined);
  if (!numericType && !values?.some((v) => typeof v === "number"))
    return json;
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, format, id, ...rest } = json;
  if (rest.enum)
    rest.enum = rest.enum.map((v) => typeof v === "number" ? String(v) : v);
  else if (typeof rest.const === "number")
    rest.const = String(rest.const);
  if (!numericType)
    return rest;
  rest.type = "string";
  if (!values)
    rest.pattern = (types.includes("number") ? number : integer).source;
  return rest;
}
var pendingRecords = new WeakMap;
function rewriteKeyNames(ctx) {
  const bySchema = new Map;
  for (const entry of ctx.seen.values()) {
    if (entry.def && !bySchema.has(entry.schema))
      bySchema.set(entry.schema, entry);
  }
  const rewrites = new Map;
  for (const record of pendingRecords.get(ctx) ?? []) {
    const seen = ctx.seen.get(record);
    const names = (seen?.def ?? seen?.schema)?.propertyNames;
    if (!names || names === true || rewrites.has(names))
      continue;
    const rewritten = stringifyKeyNames(bySchema, names, new Set);
    if (rewritten !== names)
      rewrites.set(names, rewritten);
  }
  if (!rewrites.size)
    return;
  for (const entry of ctx.seen.values()) {
    for (const carrier of [entry.schema, entry.def]) {
      const rewritten = carrier && rewrites.get(carrier.propertyNames);
      if (rewritten)
        carrier.propertyNames = rewritten;
    }
  }
}
var recordProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "object";
  const keyType = def.keyType;
  const patterns = aggregateChecks(keyType).patterns;
  if (def.mode === "loose" && patterns && patterns.size > 0) {
    const valueSchema = processSchema(def.valueType, ctx, {
      ...params,
      path: [...params.path, "patternProperties", "*"]
    });
    json.patternProperties = {};
    for (const pattern of patterns) {
      assignProp(json.patternProperties, exactPattern(pattern).source, valueSchema);
    }
  } else {
    if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
      json.propertyNames = processSchema(def.keyType, ctx, {
        ...params,
        path: [...params.path, "propertyNames"]
      });
      let pending = pendingRecords.get(ctx);
      if (!pending) {
        pending = [];
        pendingRecords.set(ctx, pending);
        ctx.deferred.push(() => rewriteKeyNames(ctx));
      }
      pending.push(schema);
    }
    json.additionalProperties = processSchema(def.valueType, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
  const keyValues = keyType._zod.values;
  const omittableOnInput = ctx.io === "input" && inputOptin(def.valueType) !== undefined;
  if (keyValues && !def.partial && !omittableOnInput) {
    const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
    if (validKeyValues.length > 0) {
      json.required = validKeyValues.map(String);
    }
  }
};
var nullableProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  if (ctx.target === "openapi-3.0") {
    seen.ref = def.innerType;
    json.nullable = true;
  } else {
    json.anyOf = [inner, { type: "null" }];
  }
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var UNREPRESENTABLE_DEFAULT = Symbol();
function serializeDefaultValue(value, schema, ctx, json, params) {
  let unrepresentable = false;
  const serialized = JSON.stringify(value, (_, val) => {
    if (typeof val !== "bigint")
      return val;
    unrepresentable = true;
    return null;
  });
  if (!unrepresentable)
    return JSON.parse(serialized);
  handleUnrepresentable(schema, ctx, json, params, "BigInt defaults cannot be represented in JSON Schema");
  return UNREPRESENTABLE_DEFAULT;
}
var defaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
  if (value !== UNREPRESENTABLE_DEFAULT)
    json.default = value;
};
var prefaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  if (ctx.io !== "input")
    return;
  const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
  if (value !== UNREPRESENTABLE_DEFAULT)
    json._prefault = value;
};
var catchProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  let catchValue;
  try {
    catchValue = def.catchValue(undefined);
  } catch {
    handleUnrepresentable(schema, ctx, json, params, "Dynamic catch values are not supported in JSON Schema");
    return;
  }
  json.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  const inIsTransform = def.in._zod.traits.has("$ZodTransform");
  const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
  processSchema(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.readOnly = true;
};
var promiseProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var optionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var lazyProcessor = (schema, ctx, _json, params) => {
  const innerType = schema._zod.innerType;
  processSchema(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
var allProcessors = {
  string: stringProcessor,
  number: numberProcessor,
  boolean: booleanProcessor,
  bigint: bigintProcessor,
  symbol: symbolProcessor,
  null: nullProcessor,
  undefined: undefinedProcessor,
  void: voidProcessor,
  never: neverProcessor,
  any: anyProcessor,
  unknown: unknownProcessor,
  date: dateProcessor,
  enum: enumProcessor,
  literal: literalProcessor,
  nan: nanProcessor,
  template_literal: templateLiteralProcessor,
  file: fileProcessor,
  success: successProcessor,
  custom: customProcessor,
  function: functionProcessor,
  transform: transformProcessor,
  map: mapProcessor,
  set: setProcessor,
  array: arrayProcessor,
  object: objectProcessor,
  union: unionProcessor,
  intersection: intersectionProcessor,
  tuple: tupleProcessor,
  record: recordProcessor,
  nullable: nullableProcessor,
  nonoptional: nonoptionalProcessor,
  default: defaultProcessor,
  prefault: prefaultProcessor,
  catch: catchProcessor,
  pipe: pipeProcessor,
  readonly: readonlyProcessor,
  promise: promiseProcessor,
  optional: optionalProcessor,
  lazy: lazyProcessor
};
function toJSONSchema(input, params) {
  if ("_idmap" in input) {
    const registry = input;
    const ctx = initializeContext({ ...params, processors: allProcessors });
    const defs = {};
    for (const entry of registry._idmap.entries()) {
      const [_, schema] = entry;
      processSchema(schema, ctx);
    }
    const schemas = {};
    const external = {
      registry,
      uri: params?.uri,
      defs
    };
    ctx.external = external;
    for (const entry of registry._idmap.entries()) {
      const [key, schema] = entry;
      extractDefs(ctx, schema);
      assignProp(schemas, key, finalize(ctx, schema));
    }
    if (Object.keys(defs).length > 0) {
      const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
      schemas.__shared = {
        [defsSegment]: defs
      };
    }
    return { schemas };
  }
  const ctx = initializeContext({ ...params, processors: allProcessors });
  processSchema(input, ctx);
  extractDefs(ctx, input);
  return finalize(ctx, input);
}
// node_modules/zod/v4/classic/errors.js
var _installedErrorProtos = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
function _lazyMethod(proto, key, make) {
  Object.defineProperty(proto, key, {
    configurable: true,
    enumerable: false,
    get() {
      const value = make(this);
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
      return value;
    },
    set(value) {
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
    }
  });
}
var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  const proto = Object.getPrototypeOf(inst);
  if (_installedErrorProtos.has(proto))
    return;
  _installedErrorProtos.add(proto);
  _lazyMethod(proto, "format", (self) => (mapper) => formatError(self, mapper));
  _lazyMethod(proto, "flatten", (self) => (mapper) => flattenError(self, mapper));
  _lazyMethod(proto, "addIssue", (self) => (issue) => {
    self.issues.push(issue);
    self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
  });
  _lazyMethod(proto, "addIssues", (self) => (issues) => {
    self.issues.push(...issues);
    self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
  });
  Object.defineProperty(proto, "isEmpty", {
    configurable: true,
    enumerable: false,
    get() {
      return this.issues.length === 0;
    }
  });
};
var ZodRealError = /* @__PURE__ */ $constructor("ZodError", initializer2, undefined, {
  Parent: Error
});

// node_modules/zod/v4/classic/parse.js
var parse2 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode = /* @__PURE__ */ _encode(ZodRealError);
var decode = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// node_modules/zod/v4/classic/schemas.js
function _ensureDefaultLocale() {
  if (!globalConfig.localeError)
    config(en_default());
}
function _ensureDefaultMemoizer() {
  if (!globalConfig.memoizer)
    config({ memoizer: memoizer() });
}
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  _ensureDefaultLocale();
  $ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
  return inst;
}, {
  check(...chks) {
    const def = this.def;
    return this.clone(mergeDefs(def, {
      checks: [
        ...def.checks ?? [],
        ...chks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
      ]
    }), { parent: true });
  },
  with(...chks) {
    return this.check(...chks);
  },
  clone(def, params) {
    return clone(this, def, params);
  },
  brand() {
    return this;
  },
  register(reg, meta) {
    reg.add(this, meta);
    return this;
  },
  refine(check, params) {
    return this.check(refine(check, params));
  },
  superRefine(refinement, params) {
    return this.check(superRefine(refinement, params));
  },
  overwrite(fn) {
    return this.check(_overwrite(fn));
  },
  optional() {
    return optional(this);
  },
  exactOptional() {
    return exactOptional(this);
  },
  nullable() {
    return nullable(this);
  },
  nullish() {
    return optional(nullable(this));
  },
  nonoptional(params) {
    return nonoptional(this, params);
  },
  array() {
    return array(this);
  },
  or(arg) {
    return union([this, arg]);
  },
  and(arg) {
    return intersection(this, arg);
  },
  transform(tx) {
    return pipe(this, transform(tx));
  },
  default(d) {
    return _default(this, d);
  },
  prefault(d) {
    return prefault(this, d);
  },
  catch(params) {
    return _catch(this, params);
  },
  pipe(target) {
    return pipe(this, target);
  },
  readonly() {
    return readonly(this);
  },
  describe(description) {
    const cl = this.clone();
    globalRegistry.add(cl, { description });
    return cl;
  },
  meta(...args) {
    if (args.length === 0)
      return globalRegistry.get(this);
    const cl = this.clone();
    globalRegistry.add(cl, args[0]);
    return cl;
  },
  isOptional() {
    return this.safeParse(undefined).success;
  },
  isNullable() {
    return this.safeParse(null).success;
  },
  apply(fn, ...args) {
    return args.length === 0 ? fn(this) : fn(this, ...args);
  },
  get "~standard"() {
    return hide(this, "~standard", {
      ...standardProps(this),
      jsonSchema: {
        input: createStandardJSONSchemaMethod(this, "input"),
        output: createStandardJSONSchemaMethod(this, "output")
      }
    });
  },
  set "~standard"(value) {
    own(this, "~standard", value);
  },
  parse: function _parse(data, params) {
    return parse2(this, data, params, { callee: _parse });
  },
  parseAsync: async function _parseAsync(data, params) {
    return await parseAsync(this, data, params, { callee: _parseAsync });
  },
  safeParse(data, params) {
    return safeParse(this, data, params);
  },
  async safeParseAsync(data, params) {
    return safeParseAsync(this, data, params);
  },
  get spa() {
    return this?.safeParseAsync;
  },
  set spa(value) {
    own(this, "spa", value);
  },
  validate(data, params) {
    return validate(this, data, params);
  },
  validateAsync(data, params) {
    return validateAsync(this, data, params);
  },
  encode: function _encode(data, params) {
    return encode(this, data, params, { callee: _encode });
  },
  decode: function _decode(data, params) {
    return decode(this, data, params, { callee: _decode });
  },
  encodeAsync: async function _encodeAsync(data, params) {
    return await encodeAsync(this, data, params, { callee: _encodeAsync });
  },
  decodeAsync: async function _decodeAsync(data, params) {
    return await decodeAsync(this, data, params, { callee: _decodeAsync });
  },
  safeEncode(data, params) {
    return safeEncode(this, data, params);
  },
  safeDecode(data, params) {
    return safeDecode(this, data, params);
  },
  async safeEncodeAsync(data, params) {
    return safeEncodeAsync(this, data, params);
  },
  async safeDecodeAsync(data, params) {
    return safeDecodeAsync(this, data, params);
  },
  toJSONSchema(params) {
    return createToJSONSchemaMethod(this, {})(params);
  },
  get description() {
    return globalRegistry.get(this)?.description;
  },
  get _def() {
    return this._zod.def;
  }
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
}, /* @__PURE__ */ derived({
  format: (inst) => aggregateChecks(inst).format ?? null,
  minLength: (inst) => aggregateChecks(inst).minimum ?? null,
  maxLength: (inst) => aggregateChecks(inst).maximum ?? null
}, {
  regex(...args) {
    return this.check(_regex(...args));
  },
  includes(...args) {
    return this.check(_includes(...args));
  },
  startsWith(...args) {
    return this.check(_startsWith(...args));
  },
  endsWith(...args) {
    return this.check(_endsWith(...args));
  },
  min(...args) {
    return this.check(_minLength(...args));
  },
  max(...args) {
    return this.check(_maxLength(...args));
  },
  length(...args) {
    return this.check(_length(...args));
  },
  nonempty(...args) {
    return this.check(_minLength(1, ...args));
  },
  lowercase(params) {
    return this.check(_lowercase(params));
  },
  uppercase(params) {
    return this.check(_uppercase(params));
  },
  trim() {
    return this.check(_trim());
  },
  normalize(...args) {
    return this.check(_normalize(...args));
  },
  toLowerCase() {
    return this.check(_toLowerCase());
  },
  toUpperCase() {
    return this.check(_toUpperCase());
  },
  slugify() {
    return this.check(_slugify());
  }
}));
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
}, {
  email(params) {
    return this.check(_email(ZodEmail, params));
  },
  url(params) {
    return this.check(_url(ZodURL, params));
  },
  jwt(params) {
    return this.check(_jwt(ZodJWT, params));
  },
  emoji(params) {
    return this.check(_emoji2(ZodEmoji, params));
  },
  guid(params) {
    return this.check(_guid(ZodGUID, params));
  },
  uuid(params) {
    return this.check(_uuid(ZodUUID, params));
  },
  uuidv4(params) {
    return this.check(_uuidv4(ZodUUID, params));
  },
  uuidv6(params) {
    return this.check(_uuidv6(ZodUUID, params));
  },
  uuidv7(params) {
    return this.check(_uuidv7(ZodUUID, params));
  },
  nanoid(params) {
    return this.check(_nanoid(ZodNanoID, params));
  },
  cuid(params) {
    return this.check(_cuid(ZodCUID, params));
  },
  cuid2(params) {
    return this.check(_cuid2(ZodCUID2, params));
  },
  ulid(params) {
    return this.check(_ulid(ZodULID, params));
  },
  base64(params) {
    return this.check(_base64(ZodBase64, params));
  },
  base64url(params) {
    return this.check(_base64url(ZodBase64URL, params));
  },
  xid(params) {
    return this.check(_xid(ZodXID, params));
  },
  ksuid(params) {
    return this.check(_ksuid(ZodKSUID, params));
  },
  ipv4(params) {
    return this.check(_ipv4(ZodIPv4, params));
  },
  ipv6(params) {
    return this.check(_ipv6(ZodIPv6, params));
  },
  cidrv4(params) {
    return this.check(_cidrv4(ZodCIDRv4, params));
  },
  cidrv6(params) {
    return this.check(_cidrv6(ZodCIDRv6, params));
  },
  e164(params) {
    return this.check(_e164(ZodE164, params));
  },
  datetime(params) {
    return this.check(_isoDateTime(ZodISODateTime, params));
  },
  date(params) {
    return this.check(_isoDate(ZodISODate, params));
  },
  time(params) {
    return this.check(_isoTime(ZodISOTime, params));
  },
  duration(params) {
    return this.check(_isoDuration(ZodISODuration, params));
  }
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
  inst.isFinite = true;
}, /* @__PURE__ */ derived({
  minValue: (inst) => {
    const { minimum, exclusiveMinimum } = aggregateChecks(inst);
    return Math.max(minimum ?? Number.NEGATIVE_INFINITY, exclusiveMinimum ?? Number.NEGATIVE_INFINITY);
  },
  maxValue: (inst) => {
    const { maximum, exclusiveMaximum } = aggregateChecks(inst);
    return Math.min(maximum ?? Number.POSITIVE_INFINITY, exclusiveMaximum ?? Number.POSITIVE_INFINITY);
  },
  isInt: (inst) => {
    const { isInt, multipleOf } = aggregateChecks(inst);
    return !!isInt || !!multipleOf?.some(Number.isSafeInteger);
  },
  format: (inst) => aggregateChecks(inst).format ?? null
}, {
  gt(value, params) {
    return this.check(_gt(value, params));
  },
  gte(value, params) {
    return this.check(_gte(value, params));
  },
  min(value, params) {
    return this.check(_gte(value, params));
  },
  lt(value, params) {
    return this.check(_lt(value, params));
  },
  lte(value, params) {
    return this.check(_lte(value, params));
  },
  max(value, params) {
    return this.check(_lte(value, params));
  },
  int(params) {
    return this.check(int(params));
  },
  safe(params) {
    return this.check(int(params));
  },
  positive(params) {
    return this.check(_gt(0, params));
  },
  nonnegative(params) {
    return this.check(_gte(0, params));
  },
  negative(params) {
    return this.check(_lt(0, params));
  },
  nonpositive(params) {
    return this.check(_lte(0, params));
  },
  multipleOf(value, params) {
    return this.check(_multipleOf(value, params));
  },
  step(value, params) {
    return this.check(_multipleOf(value, params));
  },
  finite() {
    return this;
  }
}));
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodNull = /* @__PURE__ */ $constructor("ZodNull", (inst, def) => {
  $ZodNull.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullProcessor(inst, ctx, json, params);
});
function _null3(params) {
  return _null2(ZodNull, params);
}
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor(inst, ctx, json, params);
});
function unknown() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
  inst.element = def.element;
}, {
  min(n, params) {
    return this.check(_minLength(n, params));
  },
  nonempty(params) {
    return this.check(_minLength(1, params));
  },
  max(n, params) {
    return this.check(_maxLength(n, params));
  },
  length(n, params) {
    return this.check(_length(n, params));
  },
  unwrap() {
    return this.element;
  }
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
  installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
}, {
  keyof() {
    return _enum(Object.keys(this._zod.def.shape));
  },
  catchall(catchall) {
    return this.clone(mergeDefs(this._zod.def, { catchall }));
  },
  passthrough() {
    return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
  },
  loose() {
    return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
  },
  strict() {
    return this.clone(mergeDefs(this._zod.def, { catchall: never() }));
  },
  strip() {
    return this.clone(mergeDefs(this._zod.def, { catchall: undefined }));
  },
  extend(incoming) {
    return extend(this, incoming);
  },
  safeExtend(incoming) {
    return safeExtend(this, incoming);
  },
  merge(other) {
    return merge(this, other);
  },
  pick(mask) {
    return pick(this, mask);
  },
  omit(mask) {
    return omit(this, mask);
  },
  partial(...args) {
    return partial(ZodOptional, this, args[0]);
  },
  exactPartial(...args) {
    return partial(ZodExactOptional, this, args[0], "exactPartial");
  },
  required(...args) {
    return required(ZodNonOptional, this, args[0]);
  }
});
function strictObject(shape, params) {
  return new ZodObject({
    type: "object",
    shape,
    catchall: never(),
    ...normalizeParams(params)
  });
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
var ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodDiscriminatedUnion", (inst, def) => {
  ZodUnion.init(inst, def);
  $ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
  return new ZodDiscriminatedUnion({
    type: "union",
    options,
    discriminator,
    ...normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodTuple = /* @__PURE__ */ $constructor("ZodTuple", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodTuple.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => tupleProcessor(inst, ctx, json, params);
}, {
  rest(rest) {
    return this.clone({
      ...this._zod.def,
      rest
    });
  },
  partial() {
    const def = this._zod.def;
    if (def.checks?.length)
      throw new Error(".partial() cannot be used on tuple schemas containing refinements");
    return this.clone({
      ...def,
      items: def.items.map((item) => new ZodOptional({ type: "optional", innerType: item }))
    });
  }
});
function tuple(items, _paramsOrRest, _params) {
  const hasRest = _paramsOrRest instanceof $ZodType;
  const params = hasRest ? _params : _paramsOrRest;
  const rest = hasRest ? _paramsOrRest : null;
  return new ZodTuple({
    type: "tuple",
    items,
    rest,
    ...normalizeParams(params)
  });
}
var ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodRecord.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
  if (!valueType || !valueType._zod) {
    return new ZodRecord({
      type: "record",
      keyType: string2(),
      valueType: keyType,
      ...normalizeParams(valueType)
    });
  }
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
  inst.enum = def.entries;
  inst.options = [...inst._zod.values];
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        if (!("input" in _issue))
          _issue.input = payload.value;
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output) => {
        payload.value = output;
        return payload;
      });
    }
    payload.value = output;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def) => {
  $ZodExactOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
  return new ZodExactOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : constantCatch(catchValue)
  });
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
  });
}
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodLazy = /* @__PURE__ */ $constructor("ZodLazy", (inst, def) => {
  $ZodLazy.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => lazyProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.getter();
});
function lazy(getter) {
  return new ZodLazy({
    type: "lazy",
    getter
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
  return _superRefine(fn, params);
}
function json(params) {
  const jsonSchema = lazy(() => {
    return union([string2(params), number2(), boolean2(), _null3(), array(jsonSchema), record(string2(), jsonSchema)]);
  });
  return jsonSchema;
}
// plugins/omp-build/engine/record-values.ts
var jsonSchema = json();
var identifierSchema = string2().min(1);
var sha256Schema = string2().regex(/^[0-9a-f]{64}$/);
var shaSchema = string2().min(1);
var scopeSchema = strictObject({ repository: string2(), target: string2() });
var diagnosticSchema = strictObject({
  code: string2().min(1),
  message: string2(),
  recordId: string2().min(1).optional(),
  operationId: string2().min(1).optional(),
  findingId: string2().min(1).optional(),
  path: string2().min(1).optional(),
  detail: jsonSchema.optional()
});
var labelSchema = _enum([
  "issue",
  "issue(blocking)",
  "todo",
  "suggestion(blocking)",
  "suggestion",
  "suggestion(non-blocking)",
  "nitpick",
  "thought",
  "question",
  "praise"
]);
var verdictSchema = _enum(["Request changes", "Approve with comments", "Approve", "Approve (clean)"]);
var groupSchema = _enum(["Blockers", "Warnings", "Suggestions", "Praise"]);
var phaseSchema = _enum(["spec", "panel", "recall", "intake", "synthesis", "fix", "falsification"]);
var locationSchema = strictObject({ file: string2().min(1), line: number2().int().positive() });
var policySchema = discriminatedUnion("version", [
  strictObject({ version: literal("baseline") }),
  strictObject({ version: literal("evidence-v1"), acceptanceRef: identifierSchema })
]);
var findingSchema = strictObject({
  label: labelSchema,
  description: string2().min(1),
  location: locationSchema,
  rootCause: string2().min(1),
  symptomsEvidence: string2().min(1),
  classes: array(identifierSchema).optional(),
  rawCallsites: array(locationSchema).optional(),
  confidence: jsonSchema.optional(),
  extensions: record(string2(), jsonSchema).optional()
});
var findingReportSchema = strictObject({ findings: array(findingSchema) });
var specRowSchema = strictObject({ criterionText: string2().min(1), verdict: _enum(["met", "missing"]) });
var specReportSchema = findingReportSchema.extend({ specRows: array(specRowSchema) }).strict();
var originalFindingSchema = strictObject({
  id: identifierSchema,
  attemptIndex: number2().int().nonnegative(),
  data: jsonSchema
});
var nativeProofBashCallSchema = strictObject({
  toolCallId: identifierSchema,
  input: jsonSchema,
  effectiveCwd: string2().nullable(),
  result: jsonSchema.nullable(),
  exitCode: number2().int().nullable()
});
var nativeOutcomeSchema = strictObject({
  completion: _enum(["completed", "error", "cancelled", "incomplete"]),
  strict: _enum(["valid", "invalid", "absent"]),
  raw: jsonSchema,
  bashCalls: array(nativeProofBashCallSchema).optional()
});
var submissionSchema = strictObject({
  attemptIndex: number2().int().nonnegative(),
  data: jsonSchema.nullable(),
  raw: jsonSchema,
  partialText: string2().nullable()
});
var contributionSchema = strictObject({
  content: _enum(["operator-request", "findings", "decision", "action-result"]),
  inventoryId: identifierSchema.nullable(),
  host: strictObject({
    origin: _enum(["native", "operator"]),
    phase: phaseSchema.nullable(),
    role: identifierSchema.nullable(),
    slotId: identifierSchema.nullable(),
    chunk: number2().int().nonnegative().nullable(),
    childId: identifierSchema.nullable()
  }),
  rawAttempts: array(submissionSchema),
  native: nativeOutcomeSchema.nullable(),
  structured: jsonSchema.nullable(),
  findings: array(originalFindingSchema).nullable()
});
var commandResultSchema = strictObject({
  command: string2(),
  exitCode: number2().int(),
  stdout: string2(),
  stderr: string2()
});
var implementationCommandSchema = strictObject({
  toolCallId: identifierSchema,
  command: string2(),
  exitCode: number2().int()
});
var selectedProofEvidence = { proofToolCallId: identifierSchema, proofUnavailableReason: _null3() };
var unavailableProofEvidence = { proofToolCallId: _null3(), proofUnavailableReason: string2().min(1) };
var repoRelativePathSchema = string2().min(1).regex(/^(?!\/)(?![A-Za-z]:\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\r\n\\]+$/);
var guardInventoryEntrySchema = strictObject({
  guardId: identifierSchema,
  productionGuard: string2().min(1),
  paths: array(string2().min(1)),
  intendedScenario: string2().min(1)
});
var uniqueGuardIds = (entries, context) => {
  const seen = new Set;
  entries.forEach((entry, index) => {
    if (seen.has(entry.guardId))
      context.addIssue({ code: "custom", path: [index, "guardId"], message: `Guard ${entry.guardId} is repeated` });
    seen.add(entry.guardId);
  });
};
var guardInventorySchema = array(guardInventoryEntrySchema).superRefine(uniqueGuardIds);
var appliedActionResultFields = {
  outcome: literal("applied"),
  commitSHAs: array(string2()),
  commands: array(commandResultSchema),
  proofPaths: array(repoRelativePathSchema),
  guardInventory: guardInventorySchema
};
var failedActionResultFields = {
  outcome: literal("failed"),
  commitSHAs: array(string2()),
  commands: array(commandResultSchema),
  proofPaths: array(repoRelativePathSchema),
  guardInventory: _null3()
};
var applyActionResultSchema = union([
  strictObject({ ...appliedActionResultFields, ...selectedProofEvidence }),
  strictObject({ ...appliedActionResultFields, ...unavailableProofEvidence }),
  strictObject({ ...failedActionResultFields, ...selectedProofEvidence }),
  strictObject({ ...failedActionResultFields, ...unavailableProofEvidence })
]);
var guardFactFields = {
  guardId: identifierSchema,
  removed: boolean2(),
  intendedScenario: string2().min(1),
  proofFailed: boolean2()
};
var guardFactSchema = union([
  strictObject({ ...guardFactFields, ...selectedProofEvidence }),
  strictObject({ ...guardFactFields, ...unavailableProofEvidence })
]);
var guardFactsSchema = array(guardFactSchema).min(1).superRefine(uniqueGuardIds);
var falsifyActionResultSchema = strictObject({
  facts: guardFactsSchema,
  skippedReason: string2().nullable(),
  commands: array(commandResultSchema)
});
var actionResultSchema = union([applyActionResultSchema, falsifyActionResultSchema]);
var recallClassSchema = strictObject({
  classId: identifierSchema,
  chunks: array(number2().int().nonnegative()),
  callsites: array(locationSchema),
  sourceFindingIds: array(identifierSchema)
});
var recallPlanSchema = strictObject({
  index: array(recallClassSchema),
  triggeredClassIds: array(identifierSchema),
  diagnostics: array(diagnosticSchema)
});
var slotSchema = strictObject({
  slotId: identifierSchema,
  phase: phaseSchema,
  role: identifierSchema,
  chunk: number2().int().nonnegative().nullable(),
  required: boolean2(),
  output: _enum(["spec", "findings", "decision", "action-result"]),
  classId: identifierSchema.nullable(),
  sourceFindingIds: array(identifierSchema)
});

// plugins/omp-build/engine/review-schema.ts
var observedCommentSchema = strictObject({
  locator: string2().min(1),
  nativeId: string2().min(1).nullable(),
  body: string2(),
  author: string2().min(1).nullable(),
  createdAt: string2().min(1).nullable(),
  updatedAt: string2().min(1).nullable()
});
var REVIEW_INPUT_FORMAT2 = "omp-build:review-input/3";
var reviewInputFormatSchema = literal(REVIEW_INPUT_FORMAT2);
var reviewInputSnapshotSchema = strictObject({
  body: strictObject({ body: string2(), lastEditedAt: string2().nullable() }).nullable(),
  spec: strictObject({ reference: string2().min(1), body: string2(), lastEditedAt: string2().nullable() }).nullable()
});
var reviewSubjectSchema = discriminatedUnion("kind", [
  strictObject({ kind: literal("pull-request") }),
  strictObject({ kind: literal("epic-range"), range: string2().regex(/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/) })
]);
var initialPullRequestInventorySchema = strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  inputFormat: reviewInputFormatSchema,
  input: sha256Schema.nullable(),
  slots: array(slotSchema),
  stage: literal("initial"),
  purpose: literal("review"),
  tier: _enum(["S", "F-lite", "F-full"]),
  allocation: jsonSchema,
  policy: policySchema,
  subject: strictObject({ kind: literal("pull-request") }),
  inputSnapshot: reviewInputSnapshotSchema
});
var initialEpicReviewInventorySchema = strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  inputFormat: reviewInputFormatSchema,
  input: sha256Schema.nullable(),
  slots: array(slotSchema),
  stage: literal("initial"),
  purpose: literal("review"),
  tier: _null3(),
  allocation: jsonSchema,
  policy: policySchema,
  subject: strictObject({ kind: literal("epic-range"), range: string2().regex(/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/) }),
  inputSnapshot: _null3()
});
var initialCorrectionInventorySchema = strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  inputFormat: reviewInputFormatSchema,
  input: sha256Schema.nullable(),
  slots: array(slotSchema),
  stage: literal("initial"),
  purpose: literal("correction"),
  requestId: identifierSchema,
  policy: policySchema
});
var recallInventorySchema = strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  inputFormat: reviewInputFormatSchema,
  input: sha256Schema.nullable(),
  slots: array(slotSchema),
  stage: literal("recall"),
  purpose: literal("review"),
  plan: recallPlanSchema,
  policy: policySchema
});
var synthesisInventorySchema = strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  inputFormat: reviewInputFormatSchema,
  input: sha256Schema.nullable(),
  slots: array(slotSchema),
  stage: literal("synthesis"),
  purpose: _enum(["review", "correction"]),
  policy: policySchema
});
var inventorySchema = union([
  initialPullRequestInventorySchema,
  initialEpicReviewInventorySchema,
  initialCorrectionInventorySchema,
  recallInventorySchema,
  synthesisInventorySchema
]);
var finalFindingSchema = discriminatedUnion("state", [
  strictObject({
    id: identifierSchema,
    label: labelSchema.nullable(),
    impactReason: string2().min(1),
    state: literal("usable"),
    sourceFindingIds: array(identifierSchema).min(1),
    description: string2().min(1),
    mergeReason: string2().min(1).optional()
  }),
  strictObject({
    id: identifierSchema,
    label: labelSchema.nullable(),
    impactReason: string2().min(1),
    state: literal("unusable"),
    sourceFindingIds: tuple([identifierSchema])
  })
]);
var causeSchema = strictObject({
  id: identifierSchema,
  title: string2().min(1),
  mechanism: string2().min(1),
  fix: string2().min(1),
  failure: string2().min(1),
  restored: string2().min(1),
  paths: array(string2().min(1)).min(1),
  proof: string2().min(1),
  findingIds: array(identifierSchema).min(1),
  authorization: union([literal("required"), strictObject({ optionalNeighborOf: identifierSchema })]).optional(),
  admission: jsonSchema.optional()
});
var standardsRowSchema = strictObject({ smell: string2().min(1), assessment: string2().min(1) });
var reviewStandardsSchema = union([
  strictObject({ state: literal("ras") }),
  strictObject({ state: literal("observed"), rows: array(standardsRowSchema).min(1) })
]);
var reviewDecisionSchema = strictObject({
  purpose: literal("review"),
  policy: policySchema,
  sourceContributionIds: array(identifierSchema),
  findings: array(finalFindingSchema),
  causes: array(causeSchema),
  standards: reviewStandardsSchema.nullable()
});
var correctionDecisionSchema = strictObject({
  purpose: literal("correction"),
  policy: policySchema,
  sourceContributionIds: array(identifierSchema),
  findings: array(finalFindingSchema),
  causes: array(causeSchema)
});
var decisionSchema = discriminatedUnion("purpose", [reviewDecisionSchema, correctionDecisionSchema]);
var decisionPayloadSchema = strictObject({
  originalContributionId: identifierSchema,
  judgment: decisionSchema
});
var finalReviewSchema = strictObject({
  candidateGitSHA: shaSchema,
  inputFormat: reviewInputFormatSchema,
  input: sha256Schema.nullable(),
  inventoryIds: array(identifierSchema).min(1),
  decisionId: identifierSchema
});
var fixRequestSchema = strictObject({
  requestContributionId: identifierSchema,
  existingReviewId: identifierSchema.nullable(),
  scope: string2().min(1),
  landing: literal(false)
});
var correctionResultSchema = strictObject({
  decisionId: identifierSchema,
  causeId: identifierSchema,
  attempt: union([literal(1), literal(2)]),
  outcome: _enum(["applied", "failed", "reverted", "withdrawn"]),
  commitSHAs: array(shaSchema),
  raw: jsonSchema
});
var falsificationResultSchema = strictObject({
  correctionResultId: identifierSchema,
  result: _enum(["pass", "fail", "skipped"]),
  notes: string2(),
  raw: jsonSchema
});
var debtReceiptSchema = strictObject({
  decisionId: identifierSchema,
  findingIds: array(identifierSchema),
  causeIds: array(identifierSchema),
  disposition: _enum(["filed", "deferred", "retained"]),
  target: string2().nullable(),
  evidence: jsonSchema
});
var fixResultSchema = strictObject({
  requestId: identifierSchema,
  decisionId: identifierSchema,
  candidateGitSHA: shaSchema,
  correctionResultIds: array(identifierSchema),
  falsificationResultIds: array(identifierSchema),
  debtReceiptIds: array(identifierSchema)
});
var stopSchema = strictObject({
  reason: _enum(["review-bound", "ci-failed"]),
  reviewId: identifierSchema,
  detail: jsonSchema
});

// plugins/omp-build/engine/record-digests.ts
import { createHash } from "node:crypto";
function specDigest(body) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
var failedCheckFailureSchema = strictObject({
  name: string2().min(1),
  source: string2().min(1),
  observationId: string2().min(1),
  conclusion: string2().min(1)
});
function hasFailureContent(failure) {
  return failure.name.length !== 0 && failure.source.length !== 0 && failure.observationId.length !== 0 && failure.conclusion.length !== 0;
}
function normalizedFailure(failure, seen) {
  if (!hasFailureContent(failure))
    return null;
  const key = `${failure.source}\x00${failure.observationId}`;
  if (seen.has(key))
    return null;
  seen.add(key);
  return {
    source: failure.source,
    observationId: failure.observationId,
    name: failure.name,
    conclusion: failure.conclusion
  };
}
function hasNoMissingFailures(failures) {
  return !failures.some((failure) => failure === null);
}
function compareStrings(left, right) {
  if (left < right)
    return -1;
  if (left > right)
    return 1;
  return 0;
}
function compareFailures(left, right) {
  if (left === null || right === null)
    return 0;
  return compareStrings(left.source, right.source) || compareStrings(left.observationId, right.observationId) || compareStrings(left.name, right.name) || compareStrings(left.conclusion, right.conclusion);
}
function failedCheckEvidenceDigest(input) {
  if (input.candidateGitSHA.length === 0 || input.scope.repository.length === 0 || input.scope.target.length === 0)
    return null;
  if (input.failures.length === 0)
    return null;
  const seen = new Set;
  const failures = input.failures.map((failure) => normalizedFailure(failure, seen));
  if (!hasNoMissingFailures(failures))
    return null;
  failures.sort(compareFailures);
  return specDigest(JSON.stringify({
    candidateGitSHA: input.candidateGitSHA,
    scope: { repository: input.scope.repository, target: input.scope.target },
    failures
  }));
}

// plugins/omp-build/engine/record-references.ts
var KIND_NAMES = [
  "review-attempt",
  "contribution",
  "decision",
  "review",
  "fix-request",
  "fix-result",
  "correction-result",
  "falsification-result",
  "debt-receipt",
  "stop",
  "epic-event",
  "mandate",
  "operator-control",
  "action-receipt",
  "workflow-binding"
];
var kindSchema = _enum(KIND_NAMES);
var WORKFLOW_RECORD_KINDS = ["mandate", "operator-control", "action-receipt", "workflow-binding"];
function isWorkflowKind(kind) {
  return WORKFLOW_RECORD_KINDS.includes(kind);
}
function stopBotMayAuthor(claimedKinds) {
  return claimedKinds.length > 0 && claimedKinds.every((kind) => kind === "stop");
}
var externalRecordRefSchema = strictObject({
  scope: scopeSchema,
  recordId: identifierSchema,
  kind: kindSchema
});
var scopedRecordRefSchema = externalRecordRefSchema;
var gitObjectIdSchema = string2().regex(/^[0-9a-f]{40}$/);

// plugins/omp-build/engine/workflow-mandate-schema.ts
var mandateConfigSchema = strictObject({
  productVersion: string2().min(1),
  version: string2().min(1),
  digest: sha256Schema,
  effective: jsonSchema
});
var mandateSpecSchema = strictObject({
  reference: string2().min(1),
  body: string2(),
  bodySha256: sha256Schema,
  lastEditedAt: string2().min(1)
});
var approvedChildSchema = strictObject({
  scope: scopeSchema,
  specDigest: sha256Schema,
  specBody: string2()
});
var mandateShared = {
  format: literal("omp-build-mandate/2"),
  branch: string2().min(1).nullable(),
  base: string2().min(1),
  lineageHead: shaSchema.nullable(),
  config: mandateConfigSchema,
  parent: externalRecordRefSchema.nullable(),
  antecedent: externalRecordRefSchema.nullable(),
  spec: mandateSpecSchema
};
var featureMandateSchema = strictObject({
  role: literal("feature"),
  ...mandateShared,
  run: _null3(),
  children: _null3(),
  permissions: strictObject({ landing: literal(true), correct: literal(true) })
});
var epicMandateSchema = strictObject({
  role: literal("epic"),
  ...mandateShared,
  run: string2().regex(/^[a-z0-9]{8}$/),
  children: array(approvedChildSchema),
  permissions: strictObject({ landing: boolean2(), correct: boolean2() })
});
var fixOnlyMandateSchema = strictObject({
  role: literal("fix-only"),
  ...mandateShared,
  run: _null3(),
  children: _null3(),
  permissions: strictObject({ landing: literal(false), correct: literal(true) })
});
function sameRefMeaning(refs, context) {
  const seen = new Map;
  for (const ref of refs) {
    if (ref === null)
      continue;
    const key = `${ref.scope.repository}\x00${ref.scope.target}\x00${ref.recordId}`;
    const prior = seen.get(key);
    if (prior !== undefined && prior !== ref.kind) {
      context.addIssue({
        code: "custom",
        message: "same scope and recordId must share one kind"
      });
    }
    seen.set(key, ref.kind);
  }
}
var mandatePayloadSchema = discriminatedUnion("role", [featureMandateSchema, epicMandateSchema, fixOnlyMandateSchema]).superRefine((mandate, context) => {
  if (specDigest(mandate.spec.body) !== mandate.spec.bodySha256) {
    context.addIssue({ code: "custom", path: ["spec", "bodySha256"], message: "spec body digest mismatch" });
  }
  sameRefMeaning([mandate.parent, mandate.antecedent], context);
  if (mandate.role !== "epic")
    return;
  const seenScopes = new Set;
  for (const [index, child] of mandate.children.entries()) {
    const key = `${child.scope.repository}\x00${child.scope.target}`;
    if (seenScopes.has(key)) {
      context.addIssue({ code: "custom", path: ["children", index, "scope"], message: "child scope is repeated" });
    }
    seenScopes.add(key);
    if (specDigest(child.specBody) !== child.specDigest) {
      context.addIssue({
        code: "custom",
        path: ["children", index, "specDigest"],
        message: "child snapshot digest mismatch"
      });
    }
  }
});
var disarmSchema = strictObject({ observed: literal(true), evidence: jsonSchema });
var controlShared = { controlId: identifierSchema, mandate: externalRecordRefSchema };
var operatorControlPayloadSchema = discriminatedUnion("control", [
  strictObject({ control: literal("pause-requested"), predecessor: _null3(), ...controlShared }),
  strictObject({
    control: literal("pause-confirmed"),
    predecessor: externalRecordRefSchema,
    disarm: disarmSchema,
    ...controlShared
  }),
  strictObject({ control: literal("resume"), predecessor: externalRecordRefSchema, ...controlShared }),
  strictObject({
    control: literal("abandon"),
    predecessor: externalRecordRefSchema.nullable(),
    ...controlShared
  }),
  strictObject({
    control: literal("accept-material"),
    predecessor: externalRecordRefSchema,
    assessment: externalRecordRefSchema,
    specDigest: sha256Schema,
    ...controlShared
  }),
  strictObject({
    control: literal("select-successor"),
    predecessor: externalRecordRefSchema,
    successor: externalRecordRefSchema,
    ...controlShared
  })
]).superRefine((control, context) => {
  const refs = [control.mandate, control.predecessor];
  if (control.control === "accept-material")
    refs.push(control.assessment);
  if (control.control === "select-successor")
    refs.push(control.successor);
  sameRefMeaning(refs, context);
});
var workflowBindingPayloadSchema = strictObject({
  mandate: externalRecordRefSchema,
  branch: string2().min(1),
  base: string2().min(1)
}).superRefine((payload, context) => {
  if (payload.mandate.kind !== "mandate") {
    context.addIssue({
      code: "custom",
      path: ["mandate", "kind"],
      message: "workflow binding must name a mandate"
    });
  }
});

// plugins/omp-build/engine/workflow-output-schema.ts
var specAssessmentSchema = strictObject({
  classification: _enum(["editorial", "material", "unknown"])
});
var planStepSchema = strictObject({
  id: identifierSchema,
  change: string2().min(1),
  doneWhen: string2().min(1),
  criterion: string2().min(1),
  evidence: string2().min(1),
  paths: array(repoRelativePathSchema).min(1)
});
var planBlockerRefSchema = strictObject({
  sourceId: identifierSchema,
  slotId: identifierSchema,
  blockerId: identifierSchema
});
var planResolutionSchema = strictObject({
  blocker: planBlockerRefSchema,
  stepIds: array(identifierSchema).min(1),
  reason: string2().min(1)
});
var planOutputSchema = strictObject({
  steps: array(planStepSchema).min(1),
  resolutions: array(planResolutionSchema)
}).superRefine((value, context) => {
  const stepIds = new Set;
  for (const [index, step] of value.steps.entries()) {
    if (stepIds.has(step.id)) {
      context.addIssue({ code: "custom", path: ["steps", index, "id"], message: "step id is repeated" });
    }
    stepIds.add(step.id);
  }
  const seen = new Set;
  for (const [index, resolution] of value.resolutions.entries()) {
    const key = `${resolution.blocker.sourceId}\x00${resolution.blocker.slotId}\x00${resolution.blocker.blockerId}`;
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["resolutions", index, "blocker"],
        message: "resolution reference is repeated"
      });
    }
    seen.add(key);
    for (const [stepIndex, stepId] of resolution.stepIds.entries()) {
      if (!stepIds.has(stepId)) {
        context.addIssue({
          code: "custom",
          path: ["resolutions", index, "stepIds", stepIndex],
          message: "resolution names an unknown step"
        });
      }
    }
  }
});
function planDigest(plan) {
  return specDigest(JSON.stringify(plan));
}
var planReviewBlockerSchema = strictObject({
  id: identifierSchema,
  criterion: string2().min(1),
  gap: string2().min(1)
});
var planReviewSchema = strictObject({
  outcome: _enum(["clear", "blocking"]),
  blockers: array(planReviewBlockerSchema)
}).superRefine((value, context) => {
  if (value.outcome === "clear" && value.blockers.length !== 0) {
    context.addIssue({ code: "custom", path: ["blockers"], message: "clear plan review has no blockers" });
  }
  if (value.outcome === "blocking" && value.blockers.length === 0) {
    context.addIssue({ code: "custom", path: ["blockers"], message: "blocking plan review names a blocker" });
  }
  const ids = new Set;
  for (const [index, blocker] of value.blockers.entries()) {
    if (ids.has(blocker.id)) {
      context.addIssue({ code: "custom", path: ["blockers", index, "id"], message: "blocker id is repeated" });
    }
    ids.add(blocker.id);
  }
});
var implementationOutputSchema = discriminatedUnion("outcome", [
  strictObject({
    outcome: literal("implemented"),
    commitSHAs: array(shaSchema).min(1),
    commands: array(implementationCommandSchema).min(1),
    proofToolCallId: identifierSchema,
    proofUnavailableReason: _null3(),
    reason: string2()
  }),
  strictObject({
    outcome: literal("blocked"),
    commitSHAs: array(shaSchema),
    commands: array(implementationCommandSchema),
    proofToolCallId: _null3(),
    proofUnavailableReason: string2().min(1),
    reason: string2().min(1)
  })
]);
var ciAttributionSchema = strictObject({
  attribution: _enum(["change", "pre-existing", "infra", "unknown", "out-of-scope"]),
  evidence: jsonSchema
});

// plugins/omp-build/engine/workflow-receipt-schema.ts
var workflowReceiptActionSchema = _enum([
  "frame",
  "assess-spec",
  "plan",
  "plan-review",
  "implement",
  "attribute-ci"
]);
var assessSpecExactSchema = strictObject({
  acceptedDigest: sha256Schema,
  currentDigest: sha256Schema,
  acceptedBody: string2(),
  currentBody: string2()
}).superRefine((value, context) => {
  if (specDigest(value.acceptedBody) !== value.acceptedDigest) {
    context.addIssue({ code: "custom", path: ["acceptedDigest"], message: "accepted body digest mismatch" });
  }
  if (specDigest(value.currentBody) !== value.currentDigest) {
    context.addIssue({ code: "custom", path: ["currentDigest"], message: "current body digest mismatch" });
  }
});
var frameExactSchema = strictObject({
  specDigest: sha256Schema,
  branch: string2().min(1),
  base: string2().min(1)
});
var PLAN_REVIEW_SPECIALISTS = ["R-workflow-plan-architect", "R-workflow-plan-adversarial"];
var planReviewSpecialistSchema = _enum(PLAN_REVIEW_SPECIALISTS);
var planReviewSlotSchema = strictObject({
  slotId: identifierSchema,
  specialist: planReviewSpecialistSchema
});
var planExactSchema = strictObject({
  mandateId: identifierSchema,
  specDigest: sha256Schema,
  amendsReviewActionId: identifierSchema.nullable(),
  requiredBlockers: array(planBlockerRefSchema)
}).superRefine((value, context) => {
  if (value.amendsReviewActionId === null && value.requiredBlockers.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["requiredBlockers"],
      message: "a draft does not require review blockers"
    });
  }
  const seen = new Set;
  for (const [index, ref] of value.requiredBlockers.entries()) {
    const key = `${ref.sourceId}\x00${ref.slotId}\x00${ref.blockerId}`;
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["requiredBlockers", index],
        message: "blocker reference is repeated"
      });
    }
    seen.add(key);
  }
});
var planReviewExactSchema = strictObject({
  mandateId: identifierSchema,
  specDigest: sha256Schema,
  planDigest: sha256Schema,
  draftActionId: identifierSchema
});
var implementExactSchema = strictObject({ mandateId: identifierSchema, planActionId: identifierSchema });
var ciExactSchema = strictObject({
  candidateGitSHA: shaSchema,
  scope: scopeSchema,
  failedChecks: array(string2().min(1)),
  evidenceDigest: sha256Schema,
  failures: array(failedCheckFailureSchema).min(1)
}).superRefine((value, context) => {
  const digest = failedCheckEvidenceDigest(value);
  if (digest === null || digest !== value.evidenceDigest) {
    context.addIssue({
      code: "custom",
      path: ["evidenceDigest"],
      message: "evidence digest does not match the native check identity"
    });
  }
});
var implementationAdmissionCommandSchema = strictObject({
  toolCallId: identifierSchema,
  command: string2(),
  exitCode: number2().int(),
  cwd: string2().min(1)
});
var hostEffectAdmissionSchema = strictObject({
  admitted: boolean2(),
  commits: array(gitObjectIdSchema),
  paths: array(repoRelativePathSchema),
  commands: array(implementationAdmissionCommandSchema),
  remoteBranch: string2().min(1).nullable(),
  remoteTip: gitObjectIdSchema.nullable(),
  published: boolean2(),
  reason: string2()
});
var nestedPlanContributionSchema = contributionSchema.superRefine((value, context) => {
  if (value.inventoryId !== null) {
    context.addIssue({
      code: "custom",
      path: ["inventoryId"],
      message: "plan-review contribution inventoryId must be null"
    });
  }
  if (value.host.slotId === null) {
    context.addIssue({
      code: "custom",
      path: ["host", "slotId"],
      message: "plan-review contribution names its declared slot"
    });
  }
});
function actionReceipt(action, exact, structured) {
  return [
    strictObject({
      phase: literal("start"),
      action: literal(action),
      actionId: identifierSchema,
      mandate: externalRecordRefSchema,
      exactInputs: exact
    }),
    strictObject({
      phase: literal("result"),
      action: literal(action),
      actionId: identifierSchema,
      mandate: externalRecordRefSchema,
      start: externalRecordRefSchema,
      exactInputs: exact,
      native: nativeOutcomeSchema,
      structured: structured.nullable(),
      admission: hostEffectAdmissionSchema.nullable(),
      diagnostics: array(diagnosticSchema)
    })
  ];
}
var declaredPlanSlots = (slots, context) => {
  const ids = new Set;
  const specialists = new Set;
  for (const [index, slot] of slots.entries()) {
    if (ids.has(slot.slotId)) {
      context.addIssue({ code: "custom", path: ["slots", index, "slotId"], message: `slot ${slot.slotId} is repeated` });
    }
    ids.add(slot.slotId);
    if (specialists.has(slot.specialist)) {
      context.addIssue({
        code: "custom",
        path: ["slots", index, "specialist"],
        message: `specialist ${slot.specialist} is repeated`
      });
    }
    specialists.add(slot.specialist);
  }
  for (const name of PLAN_REVIEW_SPECIALISTS) {
    if (!specialists.has(name)) {
      context.addIssue({ code: "custom", path: ["slots"], message: `missing specialist ${name}` });
    }
  }
};
var [frameStart, frameResult] = actionReceipt("frame", frameExactSchema, _null3());
var [assessStart, assessResult] = actionReceipt("assess-spec", assessSpecExactSchema, specAssessmentSchema);
var [planStart, planResult] = actionReceipt("plan", planExactSchema, planOutputSchema);
var planReviewStart = strictObject({
  phase: literal("start"),
  action: literal("plan-review"),
  actionId: identifierSchema,
  mandate: externalRecordRefSchema,
  exactInputs: planReviewExactSchema,
  slots: array(planReviewSlotSchema).length(PLAN_REVIEW_SPECIALISTS.length)
}).superRefine((value, context) => declaredPlanSlots(value.slots, context));
var planReviewResult = strictObject({
  phase: literal("result"),
  action: literal("plan-review"),
  actionId: identifierSchema,
  mandate: externalRecordRefSchema,
  start: externalRecordRefSchema,
  exactInputs: planReviewExactSchema,
  slots: array(planReviewSlotSchema).length(PLAN_REVIEW_SPECIALISTS.length),
  contributions: array(nestedPlanContributionSchema),
  native: nativeOutcomeSchema,
  structured: _null3(),
  admission: hostEffectAdmissionSchema.nullable(),
  diagnostics: array(diagnosticSchema)
});
var [implementStart, implementResult] = actionReceipt("implement", implementExactSchema, implementationOutputSchema);
var [ciStart, ciResult] = actionReceipt("attribute-ci", ciExactSchema, ciAttributionSchema);
var actionReceiptPayloadSchema = union([
  frameStart,
  frameResult,
  assessStart,
  assessResult,
  planStart,
  planResult,
  planReviewStart,
  planReviewResult,
  implementStart,
  implementResult,
  ciStart,
  ciResult
]).superRefine((receipt, context) => {
  const refs = [receipt.mandate];
  if (receipt.phase === "result")
    refs.push(receipt.start);
  sameRefMeaning(refs, context);
  if (receipt.action !== "plan-review")
    return;
  declaredPlanSlots(receipt.slots, context);
  if (receipt.phase !== "result")
    return;
  const ids = new Set(receipt.slots.map((slot) => slot.slotId));
  for (const [index, contribution] of receipt.contributions.entries()) {
    if (contribution.host.slotId === null || !ids.has(contribution.host.slotId)) {
      context.addIssue({
        code: "custom",
        path: ["contributions", index, "host", "slotId"],
        message: "contribution slot is not declared"
      });
    }
  }
});

// plugins/omp-build/engine/record-schema.ts
var envelope = {
  version: literal(1),
  recordId: identifierSchema,
  runId: identifierSchema,
  operationId: identifierSchema,
  inputs: array(identifierSchema)
};
var record2 = (kind, payload) => scopeSchema.extend({ ...envelope, kind: literal(kind), payload }).strict();
var recordSchema = discriminatedUnion("kind", [
  record2("review-attempt", inventorySchema),
  record2("contribution", contributionSchema),
  record2("decision", decisionPayloadSchema),
  record2("review", finalReviewSchema),
  record2("fix-request", fixRequestSchema),
  record2("fix-result", fixResultSchema),
  record2("correction-result", correctionResultSchema),
  record2("falsification-result", falsificationResultSchema),
  record2("debt-receipt", debtReceiptSchema),
  record2("stop", stopSchema),
  record2("epic-event", jsonSchema),
  record2("mandate", mandatePayloadSchema),
  record2("operator-control", operatorControlPayloadSchema),
  record2("action-receipt", actionReceiptPayloadSchema),
  record2("workflow-binding", workflowBindingPayloadSchema)
]);

// plugins/omp-build/engine/workflow-record-references.ts
function scopedRefsOf(record) {
  switch (record.kind) {
    case "mandate": {
      const payload = record.payload;
      return [payload.parent, payload.antecedent].filter((ref) => ref !== null);
    }
    case "operator-control": {
      const payload = record.payload;
      const refs = [payload.mandate, payload.predecessor];
      if (payload.control === "accept-material")
        refs.push(payload.assessment);
      if (payload.control === "select-successor")
        refs.push(payload.successor);
      return refs.filter((ref) => ref !== null);
    }
    case "action-receipt": {
      const payload = record.payload;
      const refs = [payload.mandate];
      if (payload.phase === "result")
        refs.push(payload.start);
      return refs;
    }
    case "workflow-binding":
      return [record.payload.mandate];
    default:
      return [];
  }
}
function partitionScopedRefs(record) {
  const scope = { repository: record.repository, target: record.target };
  const refs = scopedRefsOf(record);
  return {
    sameScope: refs.filter((ref) => equalScope(ref.scope, scope)),
    external: refs.filter((ref) => !equalScope(ref.scope, scope))
  };
}
function workflowInputMeaning(record) {
  if (!isWorkflowKind(record.kind))
    return null;
  const { sameScope, external } = partitionScopedRefs(record);
  for (const ref of sameScope) {
    if (!record.inputs.includes(ref.recordId))
      return diagnostic("unbound", `Same-scope reference ${ref.recordId} is missing from inputs`);
  }
  for (const ref of external) {
    if (record.inputs.includes(ref.recordId) || sameScope.some((item) => item.recordId === ref.recordId))
      return diagnostic("ambiguous", `External reference ${ref.recordId} must not be an input`);
  }
  return null;
}

// plugins/omp-build/engine/record-construction.ts
function parseRecord(value) {
  const format = recordFormatDiagnostic(value);
  if (format)
    return fail([format]);
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success)
    return fail([
      diagnostic("malformed", "Record does not match the canonical schema", parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })))
    ]);
  const meaning = workflowInputMeaning(parsed.data);
  return meaning === null ? { ok: true, value: parsed.data } : fail([meaning]);
}
function derivedInputs(draft) {
  switch (draft.kind) {
    case "review-attempt":
      if (draft.payload.stage !== "initial")
        return [draft.payload.rootAttemptId];
      return draft.payload.purpose === "correction" ? [draft.payload.requestId] : [];
    case "contribution":
      return draft.payload.inventoryId === null ? [] : [draft.payload.inventoryId];
    case "decision":
      return [draft.payload.originalContributionId, ...draft.payload.judgment.sourceContributionIds];
    case "review":
      return [draft.payload.decisionId, ...draft.payload.inventoryIds];
    case "fix-request":
      return draft.payload.existingReviewId === null ? [draft.payload.requestContributionId] : [draft.payload.requestContributionId, draft.payload.existingReviewId];
    case "correction-result":
      return [draft.payload.decisionId];
    case "falsification-result":
      return [draft.payload.correctionResultId];
    case "debt-receipt":
      return [draft.payload.decisionId];
    case "fix-result":
      return [
        draft.payload.requestId,
        draft.payload.decisionId,
        ...draft.payload.correctionResultIds,
        ...draft.payload.falsificationResultIds,
        ...draft.payload.debtReceiptIds
      ];
    case "stop":
      return [draft.payload.reviewId];
    case "epic-event":
      return [];
    case "mandate":
    case "operator-control":
    case "action-receipt":
    case "workflow-binding":
      return scopedRefsOf(draft).filter((ref) => equalScope(ref.scope, { repository: draft.repository, target: draft.target })).map((ref) => ref.recordId);
  }
}
function buildRecord(draft, contextInputs = []) {
  return parseRecord({ ...draft, inputs: [...new Set([...derivedInputs(draft), ...contextInputs])] });
}

// plugins/omp-build/engine/history-classification.ts
function stampedAuthority(operation) {
  const authority = Reflect.get(operation, "authority");
  return authority === "authority" || authority === "foreign" || authority === "accounted" ? authority : null;
}
function stampedClaimedKinds(operation) {
  const claimedKinds = Reflect.get(operation, "claimedKinds");
  if (!Array.isArray(claimedKinds) || claimedKinds.some((kind) => typeof kind !== "string" || kind.length === 0) || new Set(claimedKinds).size !== claimedKinds.length)
    return null;
  return claimedKinds;
}
var claimsReviewOrStop = (operation) => stampedClaimedKinds(operation)?.some((kind) => kind === "review" || kind === "stop") ?? false;
var operationClaimsWorkflow = (operation) => isWorkflowKind(operation.record?.kind ?? operation.kind ?? "") || (stampedClaimedKinds(operation)?.some((kind) => isWorkflowKind(kind)) ?? false);
function retainAccountedWorkflow(history, authorities) {
  const collided = new Set;
  const byOperationId = new Map;
  history.operations.forEach((operation, index) => {
    if (authorities[index] === "foreign" || operation.operationId === null)
      return;
    const indexes = byOperationId.get(operation.operationId) ?? [];
    indexes.push(index);
    byOperationId.set(operation.operationId, indexes);
  });
  for (const indexes of byOperationId.values()) {
    const reviewOrStop = indexes.some((index) => claimsReviewOrStop(history.operations[index]));
    const workflow = indexes.some((index) => operationClaimsWorkflow(history.operations[index]));
    if (reviewOrStop && workflow)
      for (const index of indexes)
        collided.add(index);
  }
  history.operations.forEach((operation, index) => {
    if (!operationClaimsWorkflow(operation) || authorities[index] === "foreign" || collided.has(index))
      return;
    authorities[index] = "accounted";
  });
}
function completeNativeRecord(operation, history) {
  if (operation.status !== "complete" || operation.record === null)
    return null;
  if (operation.operationId !== operation.record.operationId || operation.recordId !== operation.record.recordId || operation.kind !== operation.record.kind || !equalScope(operation.record, history.source.scope) || operation.parts.some((part) => part.author !== history.source.expectedAuthor))
    return null;
  return operation.record;
}
function uniqueCompleteRecord(recordsById, operationCounts, recordId) {
  const entries = recordsById.get(recordId);
  if (entries === undefined || entries.length !== 1)
    return null;
  const entry = entries[0];
  return operationCounts.get(entry.record.operationId) === 1 ? entry : null;
}
function correctionRoot(inventoryId, recordsById, operationCounts) {
  const inventory = uniqueCompleteRecord(recordsById, operationCounts, inventoryId);
  if (inventory?.record.kind !== "review-attempt" || inventory.record.payload.purpose !== "correction")
    return null;
  const payload = inventory.record.payload;
  if (payload.stage === "initial") {
    const request = uniqueCompleteRecord(recordsById, operationCounts, payload.requestId);
    return request?.record.kind === "fix-request" && payload.rootAttemptId === inventory.record.recordId && inventory.record.inputs.includes(request.record.recordId) ? inventory.record.recordId : null;
  }
  if (payload.stage !== "synthesis")
    return null;
  const root = uniqueCompleteRecord(recordsById, operationCounts, payload.rootAttemptId);
  if (root?.record.kind !== "review-attempt" || root.record.payload.purpose !== "correction" || root.record.payload.stage !== "initial")
    return null;
  const request = uniqueCompleteRecord(recordsById, operationCounts, root.record.payload.requestId);
  return request?.record.kind === "fix-request" && root.record.inputs.includes(request.record.recordId) && inventory.record.inputs.includes(root.record.recordId) ? root.record.recordId : null;
}
function correctionContributionRoots(recordsById, operationCounts) {
  const contributionRoots = new Map;
  for (const entries of recordsById.values()) {
    if (entries.length !== 1)
      continue;
    const entry = entries[0];
    if (entry.record.kind !== "contribution" || entry.record.payload.inventoryId === null)
      continue;
    const root = correctionRoot(entry.record.payload.inventoryId, recordsById, operationCounts);
    if (root !== null && entry.record.inputs.includes(entry.record.payload.inventoryId))
      contributionRoots.set(entry.record.recordId, root);
  }
  return contributionRoots;
}
function accountedCorrectionIndexes(recordsById, contributionRoots, authorities) {
  const accounted = new Set;
  for (const entries of recordsById.values()) {
    if (entries.length !== 1)
      continue;
    const entry = entries[0];
    if (authorities[entry.index] !== "authority")
      continue;
    if (entry.record.kind === "contribution" && contributionRoots.has(entry.record.recordId)) {
      accounted.add(entry.index);
      continue;
    }
    if (entry.record.kind !== "decision" || entry.record.payload.judgment.purpose !== "correction")
      continue;
    const root = contributionRoots.get(entry.record.payload.originalContributionId);
    const sources = entry.record.payload.judgment.sourceContributionIds;
    if (root !== undefined && sources.length > 0 && entry.record.inputs.includes(entry.record.payload.originalContributionId) && sources.every((sourceId) => contributionRoots.get(sourceId) === root) && sources.every((sourceId) => entry.record.inputs.includes(sourceId)))
      accounted.add(entry.index);
  }
  return accounted;
}
function correctionAccountedIndexes(history, authorities) {
  const recordsById = new Map;
  const operationCounts = new Map;
  for (const [index, operation] of history.operations.entries()) {
    if (authorities[index] === "foreign")
      continue;
    if (operation.operationId !== null)
      operationCounts.set(operation.operationId, (operationCounts.get(operation.operationId) ?? 0) + 1);
    const record = completeNativeRecord(operation, history);
    if (record === null)
      continue;
    const entries = recordsById.get(record.recordId) ?? [];
    entries.push({ index, record });
    recordsById.set(record.recordId, entries);
  }
  const contributionRoots = correctionContributionRoots(recordsById, operationCounts);
  return accountedCorrectionIndexes(recordsById, contributionRoots, authorities);
}
function promoteReviewDependency(recordId, visiting, byRecordId, authorities, diagnostics) {
  if (visiting.has(recordId))
    return;
  const entries = byRecordId.get(recordId);
  if (entries === undefined)
    return;
  if (entries.length !== 1) {
    for (const entry of entries)
      if (authorities[entry.index] !== "foreign")
        authorities[entry.index] = "authority";
    diagnostics.push(diagnostic("duplicate-reference", `Review dependency ${recordId} is ambiguous`));
    return;
  }
  const entry = entries[0];
  if (authorities[entry.index] === "foreign")
    return;
  authorities[entry.index] = "authority";
  const next = new Set(visiting);
  next.add(recordId);
  for (const input of entry.record.inputs)
    promoteReviewDependency(input, next, byRecordId, authorities, diagnostics);
}
function promoteReviewDependencies(history, authorities) {
  const diagnostics = [];
  const byRecordId = new Map;
  for (const [index, operation] of history.operations.entries()) {
    if (authorities[index] === "foreign" || operation.status !== "complete" || operation.record === null)
      continue;
    const entries = byRecordId.get(operation.record.recordId) ?? [];
    entries.push({ index, record: operation.record });
    byRecordId.set(operation.record.recordId, entries);
  }
  for (const [index, operation] of history.operations.entries()) {
    if (authorities[index] !== "authority" || operation.record?.kind !== "review")
      continue;
    for (const input of operation.record.inputs)
      promoteReviewDependency(input, new Set([operation.record.recordId]), byRecordId, authorities, diagnostics);
  }
  return diagnostics;
}
function classifyHistory(history) {
  const unclassified = [];
  const authorities = history.operations.map((operation, index) => {
    const authority = stampedAuthority(operation);
    if (authority !== null && stampedClaimedKinds(operation) !== null)
      return authority;
    unclassified.push(index);
    return authority ?? "authority";
  });
  const byOperationId = new Map;
  history.operations.forEach((operation, index) => {
    if (operation.operationId === null)
      return;
    const indexes = byOperationId.get(operation.operationId) ?? [];
    indexes.push(index);
    byOperationId.set(operation.operationId, indexes);
  });
  for (const indexes of byOperationId.values()) {
    const trusted = indexes.filter((index) => authorities[index] !== "foreign");
    if (trusted.length < 2)
      continue;
    const classifications = new Set(trusted.map((index) => authorities[index]));
    const reviewOrStop = trusted.some((index) => claimsReviewOrStop(history.operations[index]));
    if (classifications.size > 1 || reviewOrStop && classifications.has("authority"))
      for (const index of trusted)
        authorities[index] = "authority";
  }
  for (const index of correctionAccountedIndexes(history, authorities))
    authorities[index] = "accounted";
  const dependencyDiagnostics = promoteReviewDependencies(history, authorities);
  retainAccountedWorkflow(history, authorities);
  const classes = history.operations.map((operation, index) => ({
    index,
    operationId: operation.operationId,
    authority: authorities[index]
  }));
  const authorityOperationIds = new Set(classes.filter((entry) => entry.authority === "authority" && entry.operationId !== null).map((entry) => entry.operationId));
  return {
    classes,
    authorityHistory: {
      ...history,
      source: history.source,
      operations: history.operations.filter((_, index) => authorities[index] === "authority"),
      diagnostics: [
        ...history.diagnostics.filter((diagnostic) => diagnostic.operationId === undefined || authorityOperationIds.has(diagnostic.operationId)),
        ...dependencyDiagnostics,
        ...unclassified.map((index) => diagnostic("unclassified", `Operation ${history.operations[index].operationId ?? "unknown"} has invalid authority or kind claims`))
      ]
    }
  };
}

// plugins/omp-build/engine/history-conservation.ts
function inventoryRoot(records, inventory) {
  const root = records.get(inventory.payload.rootAttemptId);
  return root?.kind === "review-attempt" ? root : null;
}
function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function sameJsonArray(left, right) {
  if (!Array.isArray(right) || left.length !== right.length)
    return false;
  for (let index = 0;index < left.length; index++) {
    const entry = left[index];
    const candidate = right[index];
    if (entry === undefined || candidate === undefined || !sameJson(entry, candidate))
      return false;
  }
  return true;
}
function sameJsonObject(left, right) {
  if (!isJsonObject(right))
    return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length)
    return false;
  for (const key of keys) {
    if (!Object.hasOwn(right, key))
      return false;
    const entry = left[key];
    const candidate = right[key];
    if (entry === undefined || candidate === undefined || !sameJson(entry, candidate))
      return false;
  }
  return true;
}
function sameJson(left, right) {
  if (left === right)
    return true;
  if (typeof left !== typeof right || left === null || right === null)
    return false;
  return Array.isArray(left) ? sameJsonArray(left, right) : isJsonObject(left) && sameJsonObject(left, right);
}
function capturedFindingMembers(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.findings))
    return null;
  return value.findings;
}
function matchingSlot(record, slots, diagnostics, enforceClosure) {
  const slotId = record.payload.host.slotId;
  if (slotId === null || !slots.has(slotId)) {
    if (enforceClosure)
      diagnostics.push(diagnostic("unknown-reference", `Contribution ${record.recordId} names no inventory slot`, record.recordId));
    return null;
  }
  return slots.get(slotId) ?? null;
}
function validateSlotProvenance(record, slot, diagnostics, enforceClosure) {
  if (enforceClosure && (record.payload.host.phase !== slot.phase || record.payload.host.role !== slot.role || record.payload.host.chunk !== slot.chunk))
    diagnostics.push(diagnostic("unbound", `Contribution ${record.recordId} host provenance does not match slot ${slot.slotId}`));
}
function matchedSlotContributions(records, inventory, slots, diagnostics, enforceClosure) {
  const matched = new Map;
  for (const record of records.values()) {
    if (record.kind !== "contribution" || record.payload.inventoryId !== inventory.recordId)
      continue;
    const slot = matchingSlot(record, slots, diagnostics, enforceClosure);
    if (slot === null)
      continue;
    validateSlotProvenance(record, slot, diagnostics, enforceClosure);
    const entries = matched.get(slot.slotId) ?? [];
    entries.push(record);
    matched.set(slot.slotId, entries);
  }
  return matched;
}
function validateRequiredProvenance(entry, slot, diagnostics, enforceClosure) {
  if (enforceClosure && slot.required && (entry.payload.host.origin !== "native" || entry.payload.host.childId === null))
    diagnostics.push(diagnostic("unbound", `Required slot ${slot.slotId} lacks observed native child provenance`));
}
function validateRequiredRawAttempts(entry, slot, diagnostics, enforceClosure) {
  if (enforceClosure && slot.required && entry.payload.host.origin === "native" && entry.payload.rawAttempts.length === 0)
    diagnostics.push(diagnostic("incomplete", `Required native contribution ${entry.recordId} retained no raw submissions`));
}
function validateRequiredNativeOutcome(entry, slot, diagnostics, enforceClosure) {
  if (enforceClosure && slot.required && entry.payload.host.origin === "native" && (entry.payload.native === null || entry.payload.native.strict !== "valid" || entry.payload.native.completion !== "completed"))
    diagnostics.push(diagnostic("incomplete", `Required native contribution ${entry.recordId} has no valid completed outcome`));
}
function validateRequiredStructure(entry, slot, diagnostics, enforceClosure) {
  if (enforceClosure && slot.required && entry.payload.structured === null)
    diagnostics.push(diagnostic("malformed", `Required slot ${slot.slotId} has no structured output`));
}
function validateRequiredFindings(entry, slot, diagnostics, enforceClosure) {
  if (enforceClosure && slot.required && entry.payload.content === "findings" && entry.payload.findings === null)
    diagnostics.push(diagnostic("unusable-finding", `Required finding contribution ${entry.recordId} has no extractable findings`));
}
function validateSlotContent(entry, slot, diagnostics, enforceClosure) {
  const expectedContent = slot.output === "decision" ? "decision" : slot.output === "action-result" ? "action-result" : "findings";
  if (enforceClosure && entry.payload.content !== expectedContent)
    diagnostics.push(diagnostic("unbound", `Contribution ${entry.recordId} content does not satisfy slot ${slot.slotId}`));
  validateRequiredProvenance(entry, slot, diagnostics, enforceClosure);
  validateRequiredRawAttempts(entry, slot, diagnostics, enforceClosure);
  validateRequiredNativeOutcome(entry, slot, diagnostics, enforceClosure);
  validateRequiredStructure(entry, slot, diagnostics, enforceClosure);
  validateStructuredSlotContent(entry, slot, diagnostics, enforceClosure);
  validateRequiredFindings(entry, slot, diagnostics, enforceClosure);
}
function validateStructuredSlotContent(entry, slot, diagnostics, enforceClosure) {
  if (enforceClosure && entry.payload.structured !== null && slot.output === "findings" && !findingReportSchema.safeParse(entry.payload.structured).success)
    diagnostics.push(diagnostic("malformed", `Contribution ${entry.recordId} structured output is not a finding report`));
  if (enforceClosure && entry.payload.structured !== null && slot.output === "spec" && !specReportSchema.safeParse(entry.payload.structured).success)
    diagnostics.push(diagnostic("malformed", `Contribution ${entry.recordId} structured output is not a spec report`));
  if (enforceClosure && entry.payload.structured !== null && slot.output === "decision" && !decisionSchema.safeParse(entry.payload.structured).success)
    diagnostics.push(diagnostic("malformed", `Contribution ${entry.recordId} structured output is not a decision`));
  if (enforceClosure && entry.payload.structured !== null && slot.output === "action-result" && !actionResultSchema.safeParse(entry.payload.structured).success)
    diagnostics.push(diagnostic("malformed", `Contribution ${entry.recordId} structured output is not an action result`));
}
function requiredSlotsComplete(records, inventory, diagnostics, enforceClosure) {
  const slots = new Map(inventory.payload.slots.map((slot) => [slot.slotId, slot]));
  if (slots.size !== inventory.payload.slots.length)
    diagnostics.push(diagnostic("duplicate-reference", `Inventory ${inventory.recordId} repeats a slot ID`));
  const matched = matchedSlotContributions(records, inventory, slots, diagnostics, enforceClosure);
  for (const slot of inventory.payload.slots) {
    const entries = matched.get(slot.slotId) ?? [];
    if (enforceClosure && entries.length > 1)
      diagnostics.push(diagnostic("duplicate-reference", `Slot ${slot.slotId} has multiple contributions`));
    if (enforceClosure && slot.required && entries.length !== 1)
      diagnostics.push(diagnostic("missing-contribution", `Required slot ${slot.slotId} is not closed`));
    for (const entry of entries)
      validateSlotContent(entry, slot, diagnostics, enforceClosure);
  }
}

// plugins/omp-build/engine/result.ts
var unique = (values) => new Set(values).size === values.length;
var recordMap = (history) => {
  const records = new Map;
  for (const operation of history.operations) {
    if (operation.status === "complete" && operation.record !== null && !records.has(operation.record.recordId))
      records.set(operation.record.recordId, operation.record);
  }
  return records;
};

// plugins/omp-build/engine/history-graph-conservation.ts
function validateContributionFindings(record, diagnostics) {
  const contribution = record.payload;
  if (contribution.content === "decision" && contribution.findings !== null)
    diagnostics.push(diagnostic("malformed", `Decision contribution ${record.recordId} must not carry findings`));
  if (contribution.content === "operator-request" && contribution.findings !== null)
    diagnostics.push(diagnostic("malformed", `Operator request ${record.recordId} must not carry findings`));
  if (contribution.findings === null)
    return;
  if (!unique(contribution.findings.map((finding) => finding.id)))
    diagnostics.push(diagnostic("duplicate-reference", `Contribution ${record.recordId} repeats original finding IDs`));
  for (const [index, finding] of contribution.findings.entries())
    if (finding.id !== `${record.recordId}:f${index}`)
      diagnostics.push(diagnostic("unbound", `Original finding ${finding.id} does not retain its source allocation`));
}
function captureSummary(contribution) {
  const submissions = new Map;
  let duplicateSubmission = false;
  let structuredCaptured = false;
  for (const attempt of contribution.rawAttempts) {
    if (submissions.has(attempt.attemptIndex))
      duplicateSubmission = true;
    submissions.set(attempt.attemptIndex, attempt);
    if (attempt.data !== null && contribution.structured !== null && sameJson(attempt.data, contribution.structured))
      structuredCaptured = true;
  }
  return { submissions, duplicateSubmission, structuredCaptured };
}
function validateCapturedStructure(record, duplicateSubmission, structuredCaptured, diagnostics) {
  if (duplicateSubmission)
    diagnostics.push(diagnostic("duplicate-reference", `Contribution ${record.recordId} repeats a captured submission index`));
  if (record.payload.structured !== null && !structuredCaptured)
    diagnostics.push(diagnostic("unbound", `Contribution ${record.recordId} structured output is not a captured model submission`));
}
function validateCapturedFindings(record, submissions, diagnostics) {
  const contribution = record.payload;
  if (contribution.content !== "findings" || contribution.findings === null)
    return;
  for (const original of contribution.findings) {
    const attempt = submissions.get(original.attemptIndex);
    const capturedFindings = attempt === undefined || attempt.data === null ? null : capturedFindingMembers(attempt.data);
    if (capturedFindings === null || !capturedFindings.some((finding) => sameJson(finding, original.data)))
      diagnostics.push(diagnostic("unbound", `Original finding ${original.id} is not retained in its captured submission`));
  }
  for (const attempt of submissions.values()) {
    const capturedFindings = attempt.data === null ? null : capturedFindingMembers(attempt.data);
    if (capturedFindings?.some((finding) => !contribution.findings?.some((original) => original.attemptIndex === attempt.attemptIndex && sameJson(original.data, finding))))
      diagnostics.push(diagnostic("unusable-finding", `Finding contribution ${record.recordId} loses a captured submission finding`));
  }
}
function validateContributionInventory(record, records, diagnostics) {
  if (record.payload.inventoryId === null)
    return;
  const inventory = records.get(record.payload.inventoryId);
  if (inventory?.kind !== "review-attempt")
    diagnostics.push(diagnostic("unknown-reference", `Contribution ${record.recordId} references unknown inventory`));
  else if (!record.inputs.includes(inventory.recordId))
    diagnostics.push(diagnostic("unbound", `Contribution ${record.recordId} is not bound to its inventory input`));
}
function validateContribution(record, records, diagnostics) {
  validateContributionFindings(record, diagnostics);
  const { submissions, duplicateSubmission, structuredCaptured } = captureSummary(record.payload);
  validateCapturedStructure(record, duplicateSubmission, structuredCaptured, diagnostics);
  validateCapturedFindings(record, submissions, diagnostics);
  validateContributionInventory(record, records, diagnostics);
}
function validateContributionConservation(records, diagnostics) {
  for (const record of records.values())
    if (record.kind === "contribution")
      validateContribution(record, records, diagnostics);
}

// plugins/omp-build/engine/history-graph-fixes.ts
function validateFixRequest(record, records, diagnostics) {
  const request = records.get(record.payload.requestContributionId);
  if (request?.kind !== "contribution")
    diagnostics.push(diagnostic("unknown-reference", `Fix request ${record.recordId} lacks its request contribution`));
  if (!record.inputs.includes(record.payload.requestContributionId))
    diagnostics.push(diagnostic("unbound", `Fix request ${record.recordId} does not bind its request contribution`));
  if (record.payload.existingReviewId !== null) {
    const review = records.get(record.payload.existingReviewId);
    if (review?.kind !== "review" || !record.inputs.includes(record.payload.existingReviewId))
      diagnostics.push(diagnostic("unknown-reference", `Fix request ${record.recordId} lacks its existing review`));
  }
}
function validateCorrectionResult(record, records, diagnostics) {
  const decision = records.get(record.payload.decisionId);
  if (decision?.kind !== "decision" || !decision.payload.judgment.causes.some((cause) => cause.id === record.payload.causeId))
    diagnostics.push(diagnostic("unknown-reference", `Correction ${record.recordId} lacks its decision cause`));
  if (!record.inputs.includes(record.payload.decisionId))
    diagnostics.push(diagnostic("unbound", `Correction ${record.recordId} does not bind its decision`));
}
function validateFalsificationResult(record, records, diagnostics) {
  const correction = records.get(record.payload.correctionResultId);
  if (correction?.kind !== "correction-result")
    diagnostics.push(diagnostic("unknown-reference", `Falsification ${record.recordId} lacks its correction result`));
  if (!record.inputs.includes(record.payload.correctionResultId))
    diagnostics.push(diagnostic("unbound", `Falsification ${record.recordId} does not bind its correction result`));
}
function validateDebtReceipt(record, records, diagnostics) {
  const decision = records.get(record.payload.decisionId);
  if (decision?.kind !== "decision")
    diagnostics.push(diagnostic("unknown-reference", `Debt receipt ${record.recordId} lacks its decision`));
  else {
    const findings = new Set(decision.payload.judgment.findings.map((finding) => finding.id));
    const causes = new Set(decision.payload.judgment.causes.map((cause) => cause.id));
    if (record.payload.findingIds.some((id) => !findings.has(id)) || record.payload.causeIds.some((id) => !causes.has(id)))
      diagnostics.push(diagnostic("unknown-reference", `Debt receipt ${record.recordId} references another decision`));
  }
  if (!record.inputs.includes(record.payload.decisionId))
    diagnostics.push(diagnostic("unbound", `Debt receipt ${record.recordId} does not bind its decision`));
}
function validateFixResultLinks(record, ids, expectedKind, label, records, diagnostics) {
  for (const id of ids)
    if (records.get(id)?.kind !== expectedKind || !record.inputs.includes(id))
      diagnostics.push(diagnostic("unknown-reference", `Fix result ${record.recordId} lacks ${label} ${id}`));
}
function validateFixResult(record, records, diagnostics) {
  const request = records.get(record.payload.requestId);
  const decision = records.get(record.payload.decisionId);
  if (request?.kind !== "fix-request" || decision?.kind !== "decision")
    diagnostics.push(diagnostic("unknown-reference", `Fix result ${record.recordId} lacks request or decision`));
  if (!record.inputs.includes(record.payload.requestId) || !record.inputs.includes(record.payload.decisionId))
    diagnostics.push(diagnostic("unbound", `Fix result ${record.recordId} does not bind request and decision`));
  validateFixResultLinks(record, record.payload.correctionResultIds, "correction-result", "correction", records, diagnostics);
  validateFixResultLinks(record, record.payload.falsificationResultIds, "falsification-result", "falsification", records, diagnostics);
  validateFixResultLinks(record, record.payload.debtReceiptIds, "debt-receipt", "debt receipt", records, diagnostics);
}
function validateFixLinks(records, diagnostics) {
  for (const record of records.values()) {
    if (record.kind === "fix-request")
      validateFixRequest(record, records, diagnostics);
    if (record.kind === "correction-result")
      validateCorrectionResult(record, records, diagnostics);
    if (record.kind === "falsification-result")
      validateFalsificationResult(record, records, diagnostics);
    if (record.kind === "debt-receipt")
      validateDebtReceipt(record, records, diagnostics);
    if (record.kind === "fix-result")
      validateFixResult(record, records, diagnostics);
  }
}

// plugins/omp-build/engine/history-graph-review-links.ts
function knownReviewInventories(review, records, diagnostics) {
  const inventories = review.payload.inventoryIds.map((id) => records.get(id));
  if (!unique(review.payload.inventoryIds) || inventories.some((inventory) => inventory?.kind !== "review-attempt")) {
    diagnostics.push(diagnostic("unknown-reference", `Review ${review.recordId} has unknown inventory IDs`));
    return null;
  }
  return inventories.filter((inventory) => inventory?.kind === "review-attempt");
}
function inventoriesBindReview(review, inventories) {
  const rootIds = new Set(inventories.map((inventory) => inventory.payload.rootAttemptId));
  if (rootIds.size !== 1)
    return false;
  for (const inventory of inventories)
    if (inventory.payload.purpose !== "review" || inventory.payload.candidateGitSHA !== review.payload.candidateGitSHA || inventory.payload.input !== review.payload.input || !review.inputs.includes(inventory.recordId))
      return false;
  return true;
}
function validateRootInventoryList(review, rootId, records, diagnostics) {
  const allForRoot = [];
  for (const candidate of records.values())
    if (candidate.kind === "review-attempt" && candidate.payload.rootAttemptId === rootId)
      allForRoot.push(candidate.recordId);
  if (!unique(allForRoot) || allForRoot.length !== review.payload.inventoryIds.length || !allForRoot.every((id) => review.payload.inventoryIds.includes(id)))
    diagnostics.push(diagnostic("incomplete", `Review ${review.recordId} does not list every inventory for its root`));
}
function validateReviewRoot(review, rootId, records, diagnostics) {
  const root = records.get(rootId);
  if (root?.kind !== "review-attempt" || root.payload.stage !== "initial" || root.payload.purpose !== "review" || root.payload.subject.kind !== "pull-request")
    diagnostics.push(diagnostic("unbound", `Review ${review.recordId} is not bound to a pull-request subject`));
}
function validateReviewDecisionRoot(review, decision, rootId, records, diagnostics) {
  if (decision?.kind !== "decision")
    return;
  const synthesisContribution = records.get(decision.payload.originalContributionId);
  const synthesisInventory = synthesisContribution?.kind === "contribution" && synthesisContribution.payload.inventoryId !== null ? records.get(synthesisContribution.payload.inventoryId) : null;
  const decisionRoot = synthesisInventory?.kind === "review-attempt" ? inventoryRoot(records, synthesisInventory) : null;
  if (decisionRoot?.recordId !== rootId)
    diagnostics.push(diagnostic("unbound", `Review ${review.recordId} decision belongs to another inventory root`));
}
function validateReviewInventories(review, decision, inventories, records, diagnostics, enforceAdmission) {
  if (!inventoriesBindReview(review, inventories))
    diagnostics.push(diagnostic("unbound", `Review ${review.recordId} inventories do not bind one candidate`));
  const rootId = inventories[0]?.payload.rootAttemptId;
  if (rootId !== undefined) {
    validateRootInventoryList(review, rootId, records, diagnostics);
    validateReviewRoot(review, rootId, records, diagnostics);
    validateReviewDecisionRoot(review, decision, rootId, records, diagnostics);
  }
  for (const inventory of inventories)
    requiredSlotsComplete(records, inventory, diagnostics, enforceAdmission);
}
function validateReviewLinks(review, records, diagnostics, enforceAdmission) {
  const decision = records.get(review.payload.decisionId);
  if (decision?.kind !== "decision" || decision.payload.judgment.purpose !== "review")
    diagnostics.push(diagnostic("unknown-reference", `Review ${review.recordId} has no review decision`));
  if (!review.inputs.includes(review.payload.decisionId))
    diagnostics.push(diagnostic("unbound", `Review ${review.recordId} does not bind its decision`));
  const inventories = knownReviewInventories(review, records, diagnostics);
  if (inventories !== null)
    validateReviewInventories(review, decision, inventories, records, diagnostics, enforceAdmission);
}

// plugins/omp-build/engine/history-graph-links.ts
function validateDecisionCapture(decision, source, diagnostics) {
  if (source?.kind !== "contribution" || source.payload.structured === null)
    return;
  const structuredDecision = decisionSchema.safeParse(source.payload.structured);
  if (!structuredDecision.success || !sameJson(structuredDecision.data, decision.payload.judgment))
    diagnostics.push(diagnostic("unbound", `Decision ${decision.recordId} differs from its retained structured synthesis`));
  const finalSubmission = source.payload.rawAttempts.reduce((latest, attempt) => latest === null || attempt.attemptIndex > latest.attemptIndex ? attempt : latest, null);
  if (finalSubmission?.data === null || finalSubmission === null || !sameJson(finalSubmission.data, decision.payload.judgment))
    diagnostics.push(diagnostic("unbound", `Decision ${decision.recordId} is not its final captured model submission`));
}
function validateDecisionSources(decision, records, diagnostics) {
  for (const sourceId of decision.payload.judgment.sourceContributionIds) {
    const contribution = records.get(sourceId);
    if (contribution?.kind !== "contribution" || contribution.payload.content !== "findings")
      diagnostics.push(diagnostic("missing-contribution", `Decision ${decision.recordId} references non-finding contribution ${sourceId}`));
  }
}
function decisionSynthesis(decision, source, records, diagnostics) {
  if (source?.kind !== "contribution" || source.payload.content !== "decision" || source.payload.inventoryId === null)
    return null;
  const synthesis = records.get(source.payload.inventoryId);
  if (synthesis?.kind !== "review-attempt" || synthesis.payload.stage !== "synthesis" || synthesis.payload.purpose !== decision.payload.judgment.purpose) {
    diagnostics.push(diagnostic("unbound", `Decision ${decision.recordId} synthesis contribution is not bound to a matching synthesis inventory`));
    return null;
  }
  return synthesis;
}
function decisionInventoryRoot(decision, synthesis, records, diagnostics) {
  const root = inventoryRoot(records, synthesis);
  if (root === null || root.payload.purpose !== decision.payload.judgment.purpose || JSON.stringify(root.payload.policy) !== JSON.stringify(decision.payload.judgment.policy)) {
    diagnostics.push(diagnostic("unbound", `Decision ${decision.recordId} policy or purpose diverges from its root inventory`));
    return null;
  }
  return root;
}
function validateExpectedDecisionSources(decision, root, records, diagnostics) {
  for (const candidate of records.values()) {
    if (candidate.kind !== "contribution" || candidate.payload.content !== "findings" || candidate.payload.inventoryId === null)
      continue;
    const inventory = records.get(candidate.payload.inventoryId);
    if (inventory?.kind !== "review-attempt" || inventory.payload.rootAttemptId !== root.recordId)
      continue;
    if (!decision.payload.judgment.sourceContributionIds.includes(candidate.recordId))
      diagnostics.push(diagnostic("missing-contribution", `Decision ${decision.recordId} omits source contribution ${candidate.recordId}`));
  }
}
function validateDecisionSourceRoots(decision, root, records, diagnostics) {
  for (const sourceId of decision.payload.judgment.sourceContributionIds) {
    const contribution = records.get(sourceId);
    if (contribution?.kind !== "contribution" || contribution.payload.inventoryId === null)
      continue;
    const inventory = records.get(contribution.payload.inventoryId);
    if (inventory?.kind !== "review-attempt" || inventory.payload.rootAttemptId !== root.recordId)
      diagnostics.push(diagnostic("unbound", `Decision ${decision.recordId} source ${sourceId} is outside its root inventory`));
  }
}
function validateDecisionRootSlots(decision, root, records, diagnostics, enforceAdmission) {
  for (const inventory of records.values())
    if (inventory.kind === "review-attempt" && inventory.payload.rootAttemptId === root.recordId)
      requiredSlotsComplete(records, inventory, diagnostics, enforceAdmission);
  validateExpectedDecisionSources(decision, root, records, diagnostics);
  validateDecisionSourceRoots(decision, root, records, diagnostics);
}
function validateDecisionInventory(decision, source, records, diagnostics, enforceAdmission) {
  const synthesis = decisionSynthesis(decision, source, records, diagnostics);
  if (synthesis === null)
    return;
  const root = decisionInventoryRoot(decision, synthesis, records, diagnostics);
  if (root === null)
    return;
  if (decision.payload.judgment.purpose === "review" && root.payload.stage === "initial" && root.payload.purpose === "review" && root.payload.subject.kind === "pull-request" && decision.payload.judgment.standards === null)
    diagnostics.push(diagnostic("incomplete", `Pull-request review decision ${decision.recordId} lacks its standards display`));
  validateDecisionRootSlots(decision, root, records, diagnostics, enforceAdmission);
}
function validateDecision(decision, records, diagnostics, enforceAdmission) {
  const source = records.get(decision.payload.originalContributionId);
  if (source?.kind !== "contribution" || source.payload.content !== "decision")
    diagnostics.push(diagnostic("missing-contribution", `Decision ${decision.recordId} lacks its synthesis contribution`));
  if (!decision.inputs.includes(decision.payload.originalContributionId))
    diagnostics.push(diagnostic("unbound", `Decision ${decision.recordId} does not bind its synthesis contribution`));
  validateDecisionCapture(decision, source, diagnostics);
  if (source?.kind === "contribution" && source.payload.content === "decision" && source.payload.inventoryId === null)
    diagnostics.push(diagnostic("unbound", `Decision ${decision.recordId} synthesis contribution is not bound to an inventory`));
  validateDecisionSources(decision, records, diagnostics);
  validateDecisionInventory(decision, source, records, diagnostics, enforceAdmission);
}
function validateRootSlots(records, diagnostics) {
  const slotsByRoot = new Map;
  for (const inventory of records.values()) {
    if (inventory.kind !== "review-attempt")
      continue;
    const slotIds = slotsByRoot.get(inventory.payload.rootAttemptId) ?? new Set;
    for (const slot of inventory.payload.slots) {
      if (slotIds.has(slot.slotId))
        diagnostics.push(diagnostic("duplicate-reference", `Root ${inventory.payload.rootAttemptId} repeats slot ${slot.slotId}`));
      slotIds.add(slot.slotId);
    }
    slotsByRoot.set(inventory.payload.rootAttemptId, slotIds);
  }
}
function validateStop(record, records, diagnostics) {
  const review = records.get(record.payload.reviewId);
  if (review?.kind !== "review")
    diagnostics.push(diagnostic("unknown-reference", `Stop ${record.recordId} references no final review`));
  if (!record.inputs.includes(record.payload.reviewId))
    diagnostics.push(diagnostic("unbound", `Stop ${record.recordId} does not bind its final review`));
}
function validateDecisionAndReviewLinks(records, diagnostics, enforceAdmission) {
  for (const record of records.values())
    if (record.kind === "decision")
      validateDecision(record, records, diagnostics, enforceAdmission);
  for (const record of records.values())
    if (record.kind === "review")
      validateReviewLinks(record, records, diagnostics, enforceAdmission);
  validateRootSlots(records, diagnostics);
  for (const record of records.values())
    if (record.kind === "stop")
      validateStop(record, records, diagnostics);
}

// plugins/omp-build/engine/history-graph.ts
function validateOperation(operation, history, operationsById, recordsById, diagnostics) {
  if (operation.status !== "complete" || operation.record === null) {
    diagnostics.push(diagnostic(operation.status === "legacy" ? "legacy-format" : operation.status, `Operation ${operation.operationId ?? "unknown"} is not a complete canonical record`));
    return;
  }
  if (operation.operationId !== operation.record.operationId || operation.recordId !== operation.record.recordId || operation.kind !== operation.record.kind)
    diagnostics.push(diagnostic("unbound", `Observed operation metadata does not identify record ${operation.record.recordId}`));
  const authorized = operation.record.kind === "stop" ? (author) => author === history.source.expectedAuthor || history.source.stopAuthor !== null && author === history.source.stopAuthor : (author) => author === history.source.expectedAuthor;
  if (operation.parts.some((part) => !authorized(part.author)))
    diagnostics.push(diagnostic("unbound", `Operation ${operation.operationId} has an unauthorized native author`));
  const priorOperation = operationsById.get(operation.record.operationId);
  const priorRecord = recordsById.get(operation.record.recordId);
  if (priorOperation !== undefined && JSON.stringify(priorOperation) !== JSON.stringify(operation.record) || priorRecord !== undefined && JSON.stringify(priorRecord) !== JSON.stringify(operation.record))
    diagnostics.push(diagnostic("duplicate-reference", `Operation ${operation.record.operationId} or record ${operation.record.recordId} appears more than once with different content`));
  operationsById.set(operation.record.operationId, operation.record);
  recordsById.set(operation.record.recordId, operation.record);
}
function validateRecordReferences(records, scope, diagnostics) {
  for (const record of records.values()) {
    if (!equalScope(record, scope))
      diagnostics.push(diagnostic("unbound", `Record ${record.recordId} has another scope`));
    if (!unique(record.inputs))
      diagnostics.push(diagnostic("duplicate-reference", `Record ${record.recordId} repeats an input`));
    for (const input of record.inputs)
      if (!records.has(input))
        diagnostics.push(diagnostic("unknown-reference", `Record ${record.recordId} references missing input ${input}`));
  }
}
function validateAcyclicRecords(records, diagnostics) {
  const visiting = new Set;
  const visited = new Set;
  const visit = (id) => {
    if (visited.has(id))
      return;
    if (visiting.has(id)) {
      diagnostics.push(diagnostic("cycle", `Record graph contains a cycle at ${id}`));
      return;
    }
    visiting.add(id);
    const current = records.get(id);
    if (current !== undefined) {
      for (const input of current.inputs)
        if (records.has(input))
          visit(input);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of records.keys())
    visit(id);
}
function validateReviewAttempt(record, records, diagnostics) {
  const inventory = record.payload;
  if (!unique(inventory.slots.map((slot) => slot.slotId)))
    diagnostics.push(diagnostic("duplicate-reference", `Inventory ${record.recordId} repeats slot IDs`));
  if (inventory.stage === "initial") {
    if (inventory.rootAttemptId !== record.recordId)
      diagnostics.push(diagnostic("unbound", `Initial inventory ${record.recordId} does not root itself`));
    if (inventory.purpose === "review" && inventory.subject.kind === "epic-range" && inventory.subject.range.slice(-40) !== inventory.candidateGitSHA)
      diagnostics.push(diagnostic("unbound", `Epic range subject for ${record.recordId} does not end at the candidate SHA`));
  } else {
    const root = inventoryRoot(records, record);
    if (root === null || root.payload.stage !== "initial")
      diagnostics.push(diagnostic("unknown-reference", `Inventory ${record.recordId} has no initial root`));
    else if (!record.inputs.includes(root.recordId) || root.payload.candidateGitSHA !== inventory.candidateGitSHA || root.payload.input !== inventory.input || root.payload.purpose !== inventory.purpose || JSON.stringify(root.payload.policy) !== JSON.stringify(inventory.policy))
      diagnostics.push(diagnostic("unbound", `Inventory ${record.recordId} diverges from root ${inventory.rootAttemptId}`));
  }
  requiredSlotsComplete(records, record, diagnostics, false);
}
function validateRecordGraph(history, enforceAdmission = true) {
  const diagnostics = [...history.diagnostics, ...history.source.diagnostics];
  if (!history.source.complete)
    diagnostics.push(diagnostic("incomplete", "History pagination is incomplete"));
  const records = recordMap(history);
  const operationsById = new Map;
  const recordsById = new Map;
  for (const operation of history.operations)
    validateOperation(operation, history, operationsById, recordsById, diagnostics);
  validateRecordReferences(records, history.source.scope, diagnostics);
  validateAcyclicRecords(records, diagnostics);
  for (const record of records.values())
    if (record.kind === "review-attempt")
      validateReviewAttempt(record, records, diagnostics);
  validateContributionConservation(records, diagnostics);
  validateDecisionAndReviewLinks(records, diagnostics, enforceAdmission);
  validateFixLinks(records, diagnostics);
  return diagnostics.length === 0 ? { ok: true, value: [...records.values()] } : fail(diagnostics);
}

// plugins/omp-build/engine/record-projection-closure.ts
var trustedReviewOrStop = (operation) => claimsReviewOrStop(operation);
function addCollisionIndex(indexesByIdentifier, identifier, index) {
  if (identifier === null)
    return;
  const indexes = indexesByIdentifier.get(identifier) ?? [];
  indexes.push(index);
  indexesByIdentifier.set(identifier, indexes);
}
function trustedCollisionIndexes(history, classification) {
  const collisions = new Set;
  const authorities = new Map(classification.classes.map((entry) => [entry.index, entry.authority]));
  const trusted = (index) => authorities.get(index) === "authority" && trustedReviewOrStop(history.operations[index]);
  const byOperationId = new Map;
  const byRecordId = new Map;
  for (const [index, operation] of history.operations.entries()) {
    addCollisionIndex(byOperationId, operation.operationId, index);
    addCollisionIndex(byRecordId, operation.recordId, index);
    if ((operation.status === "conflict" || operation.status === "invalid") && trusted(index))
      collisions.add(index);
  }
  for (const indexes of [...byOperationId.values(), ...byRecordId.values()]) {
    if (indexes.length < 2 || !indexes.some(trusted))
      continue;
    for (const index of indexes)
      collisions.add(index);
  }
  return collisions;
}
function projectionCandidates(history, recordId) {
  return history.operations.map((operation, index) => ({ operation, index })).filter(({ operation }) => operation.recordId === recordId || operation.record?.recordId === recordId);
}
function completeProjectionRecord(record, recordId, candidates, authorities) {
  if (candidates.length === 0)
    return fail([
      diagnostic("unknown-reference", `Projection record ${record.recordId} requires absent record ${recordId}`)
    ]);
  if (candidates.some(({ index }) => authorities.get(index) === "foreign"))
    return fail([diagnostic("unbound", `Projection record ${record.recordId} requires foreign record ${recordId}`)]);
  const complete = candidates.filter(({ operation }) => operation.status === "complete" && operation.record !== null && operation.record.recordId === recordId);
  if (complete.length !== candidates.length)
    return fail([diagnostic("unbound", `Projection record ${record.recordId} has an ambiguous record ${recordId}`)]);
  const first = complete[0];
  if (first === undefined || first.operation.record === null)
    return fail([
      diagnostic("unknown-reference", `Projection record ${record.recordId} requires incomplete record ${recordId}`)
    ]);
  const canonical = first.operation.record;
  if (complete.some(({ operation }) => operation.record === null || !sameJson(operation.record, canonical)))
    return fail([diagnostic("unbound", `Projection record ${record.recordId} has conflicting records for ${recordId}`)]);
  return { ok: true, value: complete };
}
function includeProjectionDependencies(record, history, authorities, selected, resolving, recordId) {
  if (resolving.has(recordId))
    return null;
  resolving.add(recordId);
  const complete = completeProjectionRecord(record, recordId, projectionCandidates(history, recordId), authorities);
  if (!complete.ok)
    return complete.diagnostics;
  for (const { index } of complete.value)
    selected.add(index);
  const first = complete.value[0];
  if (first === undefined || first.operation.record === null)
    return [
      diagnostic("unknown-reference", `Projection record ${record.recordId} requires incomplete record ${recordId}`)
    ];
  for (const input of first.operation.record.inputs) {
    const diagnostics = includeProjectionDependencies(record, history, authorities, selected, resolving, input);
    if (diagnostics !== null)
      return diagnostics;
  }
  return null;
}
function observedProjectionRoot(record, history, authorities) {
  const candidates = projectionCandidates(history, record.recordId);
  if (candidates.some(({ index }) => authorities.get(index) !== "authority"))
    return fail([diagnostic("unbound", `Record ${record.recordId} collides with a non-authority operation`)]);
  const complete = candidates.filter(({ operation }) => operation.status === "complete" && operation.record !== null && operation.record.recordId === record.recordId);
  if (candidates.length !== complete.length)
    return fail([diagnostic("unbound", `Record ${record.recordId} has an ambiguous observed operation`)]);
  if (complete.some(({ operation }) => operation.record === null || !sameJson(operation.record, record)))
    return fail([diagnostic("unbound", `Record ${record.recordId} conflicts with its observed immutable record`)]);
  return { ok: true, value: complete };
}
function projectionHistory(record, history, classification, selected, rootComplete) {
  const operations = [...selected].sort((left, right) => left - right).map((index) => history.operations[index]);
  const operationIds = new Set(operations.flatMap((operation) => operation.operationId === null ? [] : [operation.operationId]));
  return {
    ...history,
    source: history.source,
    operations: rootComplete.length === 0 ? [
      ...operations,
      {
        operationId: record.operationId,
        recordId: record.recordId,
        kind: record.kind,
        claimedKinds: [record.kind],
        status: "complete",
        parts: [],
        record,
        authority: "authority"
      }
    ] : operations,
    diagnostics: [
      ...history.diagnostics.filter((diagnostic) => diagnostic.operationId === undefined || operationIds.has(diagnostic.operationId)),
      ...classification.authorityHistory.diagnostics.filter((diagnostic) => diagnostic.code === "unclassified")
    ]
  };
}
function projectionClosure(record, history, classification) {
  const authorities = new Map(classification.classes.map((entry) => [entry.index, entry.authority]));
  const selected = new Set(trustedCollisionIndexes(history, classification));
  const root = observedProjectionRoot(record, history, authorities);
  if (!root.ok)
    return fail(root.diagnostics);
  for (const { index } of root.value)
    selected.add(index);
  const resolving = new Set;
  for (const input of record.inputs) {
    const diagnostics = includeProjectionDependencies(record, history, authorities, selected, resolving, input);
    if (diagnostics !== null)
      return fail(diagnostics);
  }
  return { ok: true, value: projectionHistory(record, history, classification, selected, root.value) };
}

// plugins/omp-build/engine/producer-schema.ts
var PRODUCER_OUTPUTS = [
  "spec",
  "findings",
  "decision",
  "action-result",
  "spec-assessment",
  "plan",
  "plan-review",
  "implementation",
  "ci-attribution"
];
var producerSchemas = {
  spec: specReportSchema,
  findings: findingReportSchema,
  decision: decisionSchema,
  "action-result": actionResultSchema,
  "spec-assessment": specAssessmentSchema,
  plan: planOutputSchema,
  "plan-review": planReviewSchema,
  implementation: implementationOutputSchema,
  "ci-attribution": ciAttributionSchema
};
function producerJsonSchema(output) {
  if (!Object.hasOwn(producerSchemas, output)) {
    throw new Error(`producerJsonSchema has no output ${output}`);
  }
  const schema = producerSchemas[output];
  return JSON.parse(JSON.stringify(toJSONSchema(schema, { target: "draft-2020-12" })));
}
function knownLabelFromMalformedFinding(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data) || typeof data.label !== "string")
    return null;
  return labelIsKnown(data.label) ? data.label : null;
}
function inspectFinding(data, taxonomy) {
  const parsed = findingSchema.safeParse(data);
  if (!parsed.success) {
    return {
      usable: false,
      knownLabel: knownLabelFromMalformedFinding(data),
      diagnostics: [diagnostic("unusable-finding", "Original finding is not a strict canonical finding")]
    };
  }
  const diagnostics = [];
  const candidateClasses = (parsed.data.classes ?? []).filter((findingClass) => findingClass.startsWith("candidate/"));
  if (candidateClasses.length > 1)
    diagnostics.push(diagnostic("unusable-finding", "Finding has more than one advisory candidate class"));
  for (const findingClass of candidateClasses)
    if (!/^candidate\/[a-z][a-z0-9-]{1,48}$/.test(findingClass))
      diagnostics.push(diagnostic("unknown-reference", `Candidate class ${findingClass} is malformed`));
  for (const findingClass of parsed.data.classes ?? []) {
    if (!findingClass.startsWith("candidate/") && !taxonomy.includes(findingClass))
      diagnostics.push(diagnostic("unknown-reference", `Finding class ${findingClass} is not in the canonical taxonomy`));
  }
  if ((parsed.data.classes?.length ?? 0) > 0 && (parsed.data.rawCallsites?.length ?? 0) === 0)
    diagnostics.push(diagnostic("unusable-finding", "Classified finding is missing raw callsites"));
  return { usable: diagnostics.length === 0, knownLabel: parsed.data.label, diagnostics };
}
function labelIsKnown(value) {
  return [
    "issue",
    "issue(blocking)",
    "todo",
    "suggestion(blocking)",
    "suggestion",
    "suggestion(non-blocking)",
    "nitpick",
    "thought",
    "question",
    "praise"
  ].includes(value);
}

// plugins/omp-build/engine/review-groups.ts
function groupFor(label) {
  if (label === "issue" || label === "issue(blocking)" || label === "todo" || label === "suggestion(blocking)")
    return "Blockers";
  if (label === "suggestion" || label === "suggestion(non-blocking)" || label === "nitpick")
    return "Warnings";
  if (label === "thought" || label === "question")
    return "Suggestions";
  return "Praise";
}

// plugins/omp-build/engine/review-identity.ts
function reviewOperations(history) {
  const operations = [];
  const identities = new Set;
  for (const operation of history.operations) {
    if (operation.kind !== "review" && operation.record?.kind !== "review")
      continue;
    const identity = operation.operationId ?? operation.recordId ?? operation.parts.map((part) => part.locator).join("|");
    if (!identities.has(identity)) {
      identities.add(identity);
      operations.push(operation);
    }
  }
  return operations;
}
function latestUnfinishedPullRequestRoot(records) {
  let latest = null;
  for (const record of records.values()) {
    if (record.kind === "review-attempt" && record.payload.stage === "initial" && record.payload.purpose === "review" && record.payload.subject.kind === "pull-request") {
      latest = record;
      continue;
    }
    if (record.kind === "review" && latest !== null && record.payload.inventoryIds.includes(latest.recordId))
      latest = null;
  }
  return latest;
}
function analyzeReviewIdentity(history, records) {
  const reviews = reviewOperations(history);
  const incompleteFinal = reviews.some((review) => review.status !== "complete" || review.record?.kind !== "review");
  const latestOperation = incompleteFinal || reviews.length === 0 ? null : reviews[reviews.length - 1];
  const latest = latestOperation?.record?.kind === "review" ? latestOperation.record : null;
  const transportDiagnostics = [...history.diagnostics, ...history.source.diagnostics];
  if (!history.source.complete)
    transportDiagnostics.push(diagnostic("incomplete", "Review history is incomplete"));
  return {
    reviews,
    knownReviews: reviews.length,
    latest,
    latestOperation,
    transportDiagnostics,
    incompleteFinal,
    pendingRoot: latestUnfinishedPullRequestRoot(records)
  };
}

// plugins/omp-build/engine/review-decision.ts
function collectOriginals(record, records, diagnostics) {
  const originals = new Map;
  for (const sourceId of record.payload.judgment.sourceContributionIds) {
    const source = records.get(sourceId);
    if (source?.kind !== "contribution" || source.payload.content !== "findings" || source.payload.findings === null) {
      diagnostics.push(diagnostic("missing-contribution", `Decision source ${sourceId} is unavailable`));
      continue;
    }
    for (const original of source.payload.findings) {
      if (originals.has(original.id))
        diagnostics.push(diagnostic("duplicate-reference", `Original finding ${original.id} occurs in multiple sources`));
      originals.set(original.id, original.data);
    }
  }
  return originals;
}
function validateFinalFindingReferences(record, originals, diagnostics) {
  const covered = new Set;
  const findings = record.payload.judgment.findings;
  if (!unique(findings.map((finding) => finding.id)))
    diagnostics.push(diagnostic("duplicate-reference", "Decision repeats final finding IDs"));
  for (const finalFinding of findings) {
    if (!unique(finalFinding.sourceFindingIds))
      diagnostics.push(diagnostic("duplicate-reference", `Final finding ${finalFinding.id} repeats a source`));
    if (finalFinding.state === "usable" && finalFinding.sourceFindingIds.length > 1 && finalFinding.mergeReason === undefined)
      diagnostics.push(diagnostic("malformed", `Merged finding ${finalFinding.id} lacks merge reason`));
    for (const sourceId of finalFinding.sourceFindingIds) {
      if (!originals.has(sourceId)) {
        diagnostics.push(diagnostic("unknown-reference", `Final finding ${finalFinding.id} references ${sourceId}`));
        continue;
      }
      if (covered.has(sourceId))
        diagnostics.push(diagnostic("duplicate-reference", `Original finding ${sourceId} is covered more than once`));
      covered.add(sourceId);
    }
  }
  return covered;
}
function validateCauseReferences(record, diagnostics) {
  const decision = record.payload.judgment;
  const caused = new Set;
  if (!unique(decision.causes.map((cause) => cause.id)))
    diagnostics.push(diagnostic("duplicate-reference", "Decision repeats cause IDs"));
  const finalIds = new Set(decision.findings.map((finding) => finding.id));
  for (const cause of decision.causes) {
    if (!causeSchema.safeParse(cause).success)
      diagnostics.push(diagnostic("malformed", `Cause ${cause.id} is incomplete`));
    if (!unique(cause.findingIds))
      diagnostics.push(diagnostic("duplicate-reference", `Cause ${cause.id} repeats a finding`));
    for (const findingId of cause.findingIds) {
      if (!finalIds.has(findingId))
        diagnostics.push(diagnostic("unknown-reference", `Cause ${cause.id} references unknown finding ${findingId}`));
      if (caused.has(findingId))
        diagnostics.push(diagnostic("duplicate-reference", `Finding ${findingId} belongs to more than one cause`));
      caused.add(findingId);
    }
  }
}
function validateDecisionBindingsFromGraph(record, history, graph) {
  const diagnostics = graph.ok ? [] : [...graph.diagnostics];
  const records = graph.ok ? new Map(graph.value.map((entry) => [entry.recordId, entry])) : recordMap(history);
  const observed = records.get(record.recordId);
  if (observed?.kind !== "decision" || JSON.stringify(observed) !== JSON.stringify(record))
    diagnostics.push(diagnostic("unbound", `Decision ${record.recordId} is not the observed immutable decision record`));
  const decision = record.payload.judgment;
  if (!unique(decision.sourceContributionIds))
    diagnostics.push(diagnostic("duplicate-reference", `Decision ${record.recordId} repeats a source contribution`));
  const originals = collectOriginals(record, records, diagnostics);
  const covered = validateFinalFindingReferences(record, originals, diagnostics);
  for (const sourceId of originals.keys())
    if (!covered.has(sourceId))
      diagnostics.push(diagnostic("missing-contribution", `Original finding ${sourceId} is not represented in decision`));
  validateCauseReferences(record, diagnostics);
  return { admissible: diagnostics.length === 0, diagnostics, records, originals };
}
function validateDecisionBindings(record, history) {
  return validateDecisionBindingsFromGraph(record, history, validateRecordGraph(history, false));
}
function validateRetainedUnusableLabels(record, bindings) {
  const diagnostics = [];
  for (const finalFinding of record.payload.judgment.findings) {
    if (finalFinding.state !== "unusable")
      continue;
    for (const sourceId of finalFinding.sourceFindingIds) {
      const original = bindings.originals.get(sourceId);
      if (original === undefined)
        continue;
      const knownLabel = inspectFinding(original, []).knownLabel;
      if (knownLabel === null || knownLabel !== finalFinding.label)
        diagnostics.push(diagnostic("malformed", `Unusable finding ${finalFinding.id} does not retain a known source label`));
    }
  }
  return diagnostics.length === 0 ? { ok: true, value: null } : fail(diagnostics);
}
function validateReviewDecisionBindings(review, history) {
  const authorityHistory = classifyHistory(history).authorityHistory;
  const admissionGraph = validateRecordGraph(authorityHistory);
  if (!admissionGraph.ok)
    return fail(admissionGraph.diagnostics);
  const candidateDecision = recordMap(authorityHistory).get(review.payload.decisionId);
  if (candidateDecision?.kind !== "decision")
    return fail([diagnostic("unknown-reference", `Review ${review.recordId} lacks its decision`)]);
  const bindings = validateDecisionBindingsFromGraph(candidateDecision, authorityHistory, admissionGraph);
  if (!bindings.admissible)
    return fail(bindings.diagnostics);
  const identity = analyzeReviewIdentity(authorityHistory, bindings.records);
  if (identity.transportDiagnostics.length > 0)
    return fail(identity.transportDiagnostics);
  if (identity.incompleteFinal)
    return fail([diagnostic("incomplete", "A final review operation is not complete")]);
  if (identity.pendingRoot !== null)
    return fail([
      diagnostic("incomplete", `Pull-request review inventory ${identity.pendingRoot.recordId} is pending completion by its own final review`, { rootId: identity.pendingRoot.recordId, pendingRoot: true })
    ]);
  if (identity.latest === null || identity.latest.recordId !== review.recordId)
    return fail([diagnostic("unbound", `Review ${review.recordId} is not the latest canonical final review`)]);
  const observedReview = bindings.records.get(review.recordId);
  if (observedReview?.kind !== "review" || JSON.stringify(observedReview) !== JSON.stringify(review))
    return fail([diagnostic("unbound", `Review ${review.recordId} is not the observed immutable review record`)]);
  const decision = bindings.records.get(review.payload.decisionId);
  if (decision?.kind !== "decision")
    return fail([diagnostic("unknown-reference", `Review ${review.recordId} lacks its decision`)]);
  const retainedLabels = validateRetainedUnusableLabels(decision, bindings);
  if (!retainedLabels.ok)
    return retainedLabels;
  return { ok: true, value: { review: observedReview, decision, bindings } };
}
function validateDecisionPolicy(record, bindings, acceptedPolicyRef, diagnostics) {
  const retainedLabels = validateRetainedUnusableLabels(record, bindings);
  if (!retainedLabels.ok)
    diagnostics.push(...retainedLabels.diagnostics);
  const policy = record.payload.judgment.policy;
  if (policy.version === "evidence-v1" && policy.acceptanceRef !== acceptedPolicyRef)
    diagnostics.push(diagnostic("policy-not-accepted", "Evidence policy is not independently accepted"));
}
function inspectDecisionFindings(record, bindings, taxonomy, diagnostics) {
  const groups = { Blockers: [], Warnings: [], Suggestions: [], Praise: [] };
  const findings = [];
  for (const finalFinding of record.payload.judgment.findings) {
    if (finalFinding.state === "usable" && finalFinding.label === null)
      diagnostics.push(diagnostic("malformed", `Usable finding ${finalFinding.id} has no model label`));
    for (const sourceId of finalFinding.sourceFindingIds) {
      const original = bindings.originals.get(sourceId);
      if (original === undefined)
        continue;
      const inspection = inspectFinding(original, taxonomy);
      findings.push({ id: sourceId, inspection });
      if (!inspection.usable)
        diagnostics.push(...inspection.diagnostics);
    }
    if (finalFinding.label !== null)
      groups[groupFor(finalFinding.label)].push(finalFinding.id);
  }
  return { groups, findings };
}
function decisionVerdict(groups, hasUnusable, diagnostics, findingsCount) {
  if (hasUnusable || diagnostics.length > 0)
    return null;
  if (groups.Blockers.length > 0)
    return "Request changes";
  if (groups.Warnings.length > 0)
    return "Approve with comments";
  return findingsCount > 0 ? "Approve" : "Approve (clean)";
}
function validateDecision2(record, history, taxonomy, acceptedPolicyRef) {
  const bindings = validateDecisionBindingsFromGraph(record, history, validateRecordGraph(history));
  const diagnostics = [...bindings.diagnostics];
  validateDecisionPolicy(record, bindings, acceptedPolicyRef, diagnostics);
  const inspected = inspectDecisionFindings(record, bindings, taxonomy, diagnostics);
  const hasUnusable = record.payload.judgment.findings.some((finding) => finding.state === "unusable") || inspected.findings.some(({ inspection }) => !inspection.usable);
  const verdict = decisionVerdict(inspected.groups, hasUnusable, diagnostics, record.payload.judgment.findings.length);
  return {
    admissible: verdict !== null,
    groups: inspected.groups,
    verdict,
    findings: inspected.findings,
    diagnostics
  };
}

// plugins/omp-build/engine/record-projection.ts
function stringified(value) {
  return JSON.stringify(value, null, 2) ?? "null";
}
function externalReferenceDiagnostic(ref, externalHistories) {
  const foreign = externalHistories.find((item) => equalScope(item.source.scope, ref.scope));
  if (foreign === undefined)
    return diagnostic("missing-history", `No history was supplied for ${ref.scope.repository} ${ref.scope.target}`);
  if (!foreign.source.complete)
    return diagnostic("incomplete", "External history pagination is incomplete");
  const matches = foreign.operations.filter((operation) => operation.record?.recordId === ref.recordId || operation.recordId === ref.recordId);
  if (matches.length === 0)
    return diagnostic("unknown", `Record ${ref.recordId} is not in the foreign history`);
  if (matches.some((operation) => operation.status === "conflict"))
    return diagnostic("conflict", `Record ${ref.recordId} has conflicting parts`);
  if (matches.some((operation) => operation.status !== "complete" || operation.record === null || operation.authority === "foreign"))
    return diagnostic("unconfirmed", `Record ${ref.recordId} is not a complete authenticated record`);
  const bodies = new Set(matches.map((operation) => JSON.stringify(operation.record)));
  if (bodies.size !== 1)
    return diagnostic("ambiguous", `Record ${ref.recordId} has incompatible duplicates`);
  return matches[0]?.record?.kind !== ref.kind ? diagnostic("kind-mismatch", `Record ${ref.recordId} kind does not match the reference`) : null;
}
function workflowReferenceDiagnostic(record, records, externalHistories) {
  for (const ref of scopedRefsOf(record)) {
    if (equalScope(ref.scope, { repository: record.repository, target: record.target })) {
      const found = records.get(ref.recordId);
      if (found === undefined)
        return diagnostic("unknown-reference", `Record ${record.recordId} lacks same-scope input ${ref.recordId}`);
      if (found.kind !== ref.kind)
        return diagnostic("kind-mismatch", `Record ${ref.recordId} is ${found.kind}, not ${ref.kind}`);
      continue;
    }
    const externalDiagnostic = externalReferenceDiagnostic(ref, externalHistories);
    if (externalDiagnostic !== null)
      return externalDiagnostic;
  }
  return null;
}
function projectWorkflowRecord(record, history, externalHistories) {
  const meaning = workflowInputMeaning(record);
  if (meaning !== null)
    return fail([meaning]);
  if (!history.source.complete || !equalScope(record, history.source.scope))
    return fail([
      diagnostic("unbound", `Record ${record.recordId} cannot be projected outside a complete bound history`)
    ]);
  const records = recordMap(history);
  const home = records.get(record.recordId);
  if (home !== undefined && JSON.stringify(home) !== JSON.stringify(record))
    return fail([
      diagnostic("conflict", `Record ${record.recordId} conflicts with the complete record already in this history`)
    ]);
  if (history.operations.some((operation) => operation.record?.recordId === record.recordId && operation.authority === "foreign"))
    return fail([diagnostic("foreign", `Record ${record.recordId} is not from the expected author`)]);
  const referenceDiagnostic = workflowReferenceDiagnostic(record, records, externalHistories);
  if (referenceDiagnostic !== null)
    return fail([referenceDiagnostic]);
  return {
    ok: true,
    value: `# OMP build record

- Kind: ${record.kind}
- Record: ${record.recordId}
- Operation: ${record.operationId}

\`\`\`json
${stringified(record.payload)}
\`\`\``
  };
}
function projectReviewRecord(record, history, records, config) {
  const decision = records.get(record.payload.decisionId);
  if (decision?.kind !== "decision")
    return fail([diagnostic("unknown-reference", `Review ${record.recordId} lacks its decision`)]);
  if (config === null || typeof config !== "object" || !Array.isArray(Reflect.get(config, "taxonomy")) || Reflect.get(config, "taxonomy").some((classId) => typeof classId !== "string") || Reflect.get(config, "acceptedPolicy") !== null && typeof Reflect.get(config, "acceptedPolicy") !== "string")
    return fail([diagnostic("unbound", `Review ${record.recordId} has no valid projection policy context`)]);
  const assessment = validateDecision2(decision, history, config.taxonomy, config.acceptedPolicy);
  if (!assessment.admissible || assessment.verdict === null)
    return fail(assessment.diagnostics.length > 0 ? assessment.diagnostics : [diagnostic("unusable-finding", "Review decision is not admissible")]);
  const provenance = decision.payload.judgment.sourceContributionIds.map((sourceId) => {
    const source = records.get(sourceId);
    return source?.kind === "contribution" ? { contributionId: sourceId, host: source.payload.host, originals: source.payload.findings } : { contributionId: sourceId };
  });
  const standards = decision.payload.judgment.purpose === "review" ? decision.payload.judgment.standards : null;
  const standardsDisplay = standards === null ? "smells: unavailable" : standards.state === "ras" ? "smells: RAS" : standards.rows.map((row) => `- possible ${row.smell}: ${row.assessment}`).join(`
`);
  return {
    ok: true,
    value: `# OMP build review

**Verdict: ${assessment.verdict}**

- Record: ${record.recordId}
- Decision: ${record.payload.decisionId}
- Candidate: ${record.payload.candidateGitSHA}
- Input: ${record.payload.input ?? "none"}

## Findings

${stringified(decision.payload.judgment.findings)}

## Standards

${standardsDisplay}

## Source provenance

${stringified(provenance)}`
  };
}
function projectOperatorContribution(record) {
  const native = record.payload.native === null ? null : { completion: record.payload.native.completion, strict: record.payload.native.strict };
  return {
    ok: true,
    value: `# OMP build contribution

- Canonical frame record: ${record.recordId}
- Canonical frame operation: ${record.operationId}

\`\`\`json
${stringified({ ...record.payload, native })}
\`\`\``
  };
}
function projectRecord(record, history, config, externalHistories = []) {
  if (isWorkflowKind(record.kind))
    return projectWorkflowRecord(record, history, externalHistories);
  const closure = projectionClosure(record, history, classifyHistory(history));
  if (!closure.ok)
    return fail(closure.diagnostics);
  const projectionHistory = closure.value;
  const graph = validateRecordGraph(projectionHistory);
  if (!graph.ok)
    return fail(graph.diagnostics);
  if (!projectionHistory.source.complete || !equalScope(record, projectionHistory.source.scope))
    return fail([
      diagnostic("unbound", `Record ${record.recordId} cannot be projected outside a complete bound history`)
    ]);
  const records = new Map(graph.value.map((entry) => [entry.recordId, entry]));
  if (record.kind === "review")
    return projectReviewRecord(record, projectionHistory, records, config);
  if (record.kind === "contribution" && record.payload.host.origin === "operator")
    return projectOperatorContribution(record);
  return {
    ok: true,
    value: `# OMP build record

- Kind: ${record.kind}
- Record: ${record.recordId}
- Operation: ${record.operationId}

\`\`\`json
${stringified(record.payload)}
\`\`\``
  };
}

// plugins/omp-build/adapters/github/types.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

class GitHubHistoryReadError extends Error {
  diagnostics;
  constructor(message, diagnostics) {
    super(message);
    this.name = "GitHubHistoryReadError";
    this.diagnostics = diagnostics;
  }
}
var execFileAsync = promisify(execFile);
var WIRE_PREFIX = "<!-- omp-build-record ";
var HEADER = /^<!-- omp-build-record v=(1) kind=([a-z][a-z0-9-]*) id=([^\s<>]+) operationId=([^\s<>]+) part=([1-9][0-9]*)\/([1-9][0-9]*) data=([A-Za-z0-9_-]+) -->\n[\s\S]*$/;
var RECORD_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
var encoder = new TextEncoder;
var decoder = new TextDecoder("utf-8", { fatal: true });
function diagnostic2(code, message, detail) {
  return detail === undefined ? { code, message } : { code, message, detail };
}
function utf8(value) {
  return encoder.encode(value);
}
function utf8Bytes(value) {
  return utf8(value).byteLength;
}
function base64url2(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
function canonicalUtf8(value) {
  try {
    return decoder.decode(utf8(value)) === value;
  } catch {
    return false;
  }
}
function decodeHeaderIdentifier(value) {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && encodeURIComponent(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}
function defaultGh(cwd, args) {
  return execFileAsync("gh", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  }).then(({ stdout }) => String(stdout).trim());
}
function gh(options) {
  return options.gh ?? defaultGh;
}
function targetNumber(scope) {
  const separator = scope.target.lastIndexOf("#");
  const repository = separator > 0 ? scope.target.slice(0, separator) : "";
  const number = separator > 0 ? Number(scope.target.slice(separator + 1)) : Number.NaN;
  if (!RECORD_REPOSITORY.test(scope.repository) || repository !== scope.repository || !Number.isSafeInteger(number) || number < 1) {
    throw new GitHubHistoryReadError("GitHub scope is invalid", [
      diagnostic2("invalid-scope", `Scope ${scope.target} is not a GitHub repository issue target`)
    ]);
  }
  return number;
}
function parseComment(value, scope, page, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GitHubHistoryReadError("GitHub returned an invalid comment object", [
      diagnostic2("invalid-github-response", "Comment pagination returned a non-object")
    ]);
  }
  const entry = value;
  const id = typeof entry.id === "number" || typeof entry.id === "string" ? String(entry.id) : null;
  const user = entry.user;
  const author = user !== null && typeof user === "object" && !Array.isArray(user) && typeof user.login === "string" ? user.login : null;
  return {
    locator: id === null ? `${scope.target}:page:${page}:index:${index}` : `${scope.target}:comment:${id}`,
    nativeId: id,
    body: typeof entry.body === "string" ? entry.body : "",
    author,
    createdAt: typeof entry.created_at === "string" ? entry.created_at : null,
    updatedAt: typeof entry.updated_at === "string" ? entry.updated_at : null
  };
}
function viewerCredentialKey() {
  return `${process.env.GH_HOST ?? ""}\x00${process.env.GH_CONFIG_DIR ?? ""}\x00${process.env.GH_TOKEN ?? ""}\x00${process.env.GITHUB_TOKEN ?? ""}`;
}
var cachedViewer;
async function resolveViewerLogin(options) {
  const login = (await gh(options)(options.cwd, ["api", "user", "--jq", ".login"])).trim();
  if (!login || /\s/.test(login)) {
    throw new GitHubHistoryReadError("GitHub did not return a native login", [
      diagnostic2("missing-native-author", "GitHub viewer login is absent or invalid")
    ]);
  }
  return login;
}
async function viewer(options) {
  const key = viewerCredentialKey();
  if (cachedViewer?.key === key)
    return cachedViewer.value;
  const value = resolveViewerLogin(options).catch((error) => {
    if (cachedViewer?.key === key)
      cachedViewer = undefined;
    throw error;
  });
  cachedViewer = { key, value };
  return value;
}
function expectedReadAuthor(options) {
  const configured = options.readAuthor ?? options.automationLogin;
  return configured === undefined ? viewer(options) : Promise.resolve(configured);
}

// plugins/omp-build/adapters/github/history-authority.ts
var KNOWN_KINDS = {
  "review-attempt": true,
  contribution: true,
  decision: true,
  review: true,
  "fix-request": true,
  "fix-result": true,
  "correction-result": true,
  "falsification-result": true,
  "debt-receipt": true,
  proof: true,
  stop: true,
  "epic-event": true,
  ...Object.fromEntries(WORKFLOW_RECORD_KINDS.map((kind) => [kind, true]))
};
var ACCOUNTED_KINDS = {
  proof: true,
  "epic-event": true,
  "correction-result": true,
  "falsification-result": true,
  "debt-receipt": true,
  "fix-result": true,
  ...Object.fromEntries(WORKFLOW_RECORD_KINDS.map((kind) => [kind, true]))
};
function looseHeaderClue(comment) {
  const newline = comment.body.indexOf(`
`);
  const header = comment.body.slice(0, newline === -1 ? comment.body.length : newline);
  const headerValue = (field) => {
    const value = new RegExp(`\\b${field}=([^\\s<>]+)`).exec(header)?.[1];
    return value === undefined ? null : decodeHeaderIdentifier(value) ?? value;
  };
  return {
    comment,
    operationId: headerValue("operationId"),
    recordId: headerValue("id"),
    kind: headerValue("kind")
  };
}
function withClaimedKinds(operation) {
  const { parsedKind, ...read } = operation;
  const claimedKinds = [];
  const claim = (kind) => {
    if (kind !== null && kind !== undefined && !claimedKinds.includes(kind))
      claimedKinds.push(kind);
  };
  for (const part of read.parts)
    claim(looseHeaderClue(part).kind);
  claim(read.kind);
  claim(parsedKind);
  claim(read.record?.kind);
  return { ...read, claimedKinds: claimedKinds.sort() };
}
function hasConflictingPartMetadata(operation, kind) {
  const clues = operation.parts.map(looseHeaderClue);
  const kinds = new Set(clues.map((clue) => clue.kind).filter((value) => value !== null));
  const recordIds = new Set(clues.map((clue) => clue.recordId).filter((value) => value !== null));
  return kinds.size > 1 || kind !== null && kinds.size === 1 && !kinds.has(kind) || recordIds.size > 1 || operation.recordId !== null && recordIds.size === 1 && !recordIds.has(operation.recordId);
}
function collidesWithOtherOperation(operation, clues) {
  const ownParts = new Set(operation.parts.map((part) => part.locator));
  return clues.some((clue) => !ownParts.has(clue.comment.locator) && (operation.operationId !== null && clue.operationId === operation.operationId || operation.recordId !== null && clue.recordId === operation.recordId));
}
function hasInvalidAuthoritySource(operation, kind, clues) {
  const authors = new Set(operation.parts.map((part) => part.author));
  return kind === null || KNOWN_KINDS[kind] === undefined || authors.size !== 1 || authors.has(null) || !operation.parts.every((part) => part.nativeId !== null) || hasConflictingPartMetadata(operation, kind) || collidesWithOtherOperation(operation, clues);
}
function isCompleteCorrection(operation) {
  return operation.status === "complete" && operation.record !== null && (operation.record.kind === "fix-request" || operation.record.kind === "review-attempt" && operation.record.payload.purpose === "correction");
}
function operationAuthority(operation, history, clues) {
  const kind = operation.record?.kind ?? operation.kind;
  const author = operation.parts[0]?.author;
  if (author === null || author === undefined)
    return "authority";
  const trusted = author === history.expectedAuthor || author === history.stopAuthor && stopBotMayAuthor(operation.claimedKinds);
  if (!trusted)
    return "foreign";
  if (kind === null || hasInvalidAuthoritySource(operation, kind, clues))
    return "authority";
  if (operation.claimedKinds.some((claim) => claim !== kind))
    return "authority";
  if (isCompleteCorrection(operation))
    return "accounted";
  if (kind === "review" || kind === "stop")
    return "authority";
  return ACCOUNTED_KINDS[kind] === true ? "accounted" : "authority";
}

// plugins/omp-build/adapters/github/history-encoder.ts
function failure2(diagnostics) {
  return { ok: false, diagnostics };
}
function header(record, part, total, data) {
  return `<!-- omp-build-record v=1 kind=${record.kind} id=${encodeURIComponent(record.recordId)} operationId=${encodeURIComponent(record.operationId)} part=${part}/${total} data=${data} -->`;
}
function textPrefix(value, offset, byteLimit) {
  if (byteLimit < 0)
    return null;
  let bytes = 0;
  let next = offset;
  for (const character of value.slice(offset)) {
    const width = utf8Bytes(character);
    if (bytes + width > byteLimit)
      break;
    bytes += width;
    next += character.length;
  }
  return { text: value.slice(offset, next), next };
}
function encodeParts(record, projection, maxCommentBytes) {
  if (!Number.isSafeInteger(maxCommentBytes) || maxCommentBytes < 1)
    return failure2([diagnostic2("invalid-limit", "Comment byte limit must be a positive safe integer")]);
  try {
    encodeURIComponent(record.recordId);
    encodeURIComponent(record.operationId);
  } catch {
    return failure2([diagnostic2("invalid-framing", "Record and operation IDs must be valid Unicode identifiers")]);
  }
  const serialized = JSON.stringify(record);
  if (!canonicalUtf8(serialized) || !canonicalUtf8(projection))
    return failure2([diagnostic2("invalid-encoding", "Record projection is not canonical UTF-8")]);
  const encoded = base64url2(utf8(serialized));
  const maximumParts = encoded.length + utf8Bytes(projection) + 1;
  for (let total = 1;total <= maximumParts; total += 1) {
    const parts = [];
    let dataOffset = 0;
    let projectionOffset = 0;
    let valid = true;
    for (let part = 1;part <= total; part += 1) {
      const remainingParts = total - part + 1;
      const dataLength = Math.ceil((encoded.length - dataOffset) / remainingParts);
      const data = encoded.slice(dataOffset, dataOffset + dataLength);
      const frame = header(record, part, total, data);
      const text = textPrefix(projection, projectionOffset, maxCommentBytes - utf8Bytes(frame) - 1);
      if (text === null || utf8Bytes(frame) + 1 + utf8Bytes(text.text) > maxCommentBytes) {
        valid = false;
        break;
      }
      parts.push(`${frame}
${text.text}`);
      dataOffset += data.length;
      projectionOffset = text.next;
    }
    if (valid && dataOffset === encoded.length && projectionOffset === projection.length)
      return { ok: true, value: parts };
  }
  return failure2([
    diagnostic2("comment-too-large", "The record and complete human projection cannot fit the requested comment byte limit")
  ]);
}

// plugins/omp-build/adapters/github/history-framing.ts
function frameFrom(comment) {
  if (!comment.body.startsWith(WIRE_PREFIX))
    return null;
  const match = HEADER.exec(comment.body);
  if (match === null) {
    const clue = looseHeaderClue(comment);
    return {
      comment,
      operationId: clue.operationId,
      recordId: clue.recordId,
      kind: clue.kind,
      diagnostic: diagnostic2("invalid-framing", `Comment ${comment.locator} has a malformed canonical record header`)
    };
  }
  const [, version, kind, recordIdText, operationIdText, partText, totalText, data] = match;
  const recordId = decodeHeaderIdentifier(recordIdText);
  const operationId = decodeHeaderIdentifier(operationIdText);
  if (recordId === null || operationId === null) {
    return {
      comment,
      operationId,
      recordId,
      kind,
      diagnostic: diagnostic2("invalid-framing", `Comment ${comment.locator} has non-canonical record identifiers`)
    };
  }
  const part = Number(partText);
  const total = Number(totalText);
  if (part > total || !Number.isSafeInteger(part) || !Number.isSafeInteger(total)) {
    return {
      comment,
      operationId,
      recordId,
      kind,
      diagnostic: diagnostic2("invalid-framing", `Comment ${comment.locator} has an invalid part range`)
    };
  }
  return { comment, version, kind, recordId, operationId, part, total, data };
}
function legacyKind(body) {
  const marker = /^<!-- omp-build:([a-z][a-z0-9-]*)\b/.exec(body);
  if (marker === null || body.startsWith(WIRE_PREFIX))
    return null;
  return marker[1] === "review" || marker[1] === "final-review" ? "review" : marker[1];
}
function withOperationId(diagnostics, operationId) {
  return operationId === null ? diagnostics : diagnostics.map((entry) => ({ ...entry, operationId }));
}
function invalid(operationId, first, status, parts, diagnostics, parsedKind) {
  return {
    operation: {
      operationId,
      recordId: first.recordId,
      kind: first.kind,
      status,
      parts,
      record: null,
      ...parsedKind === undefined ? {} : { parsedKind }
    },
    diagnostics
  };
}
function hasConflictingMetadata(frames, first) {
  return !frames.every((frame) => frame.version === first.version && frame.kind === first.kind && frame.recordId === first.recordId && frame.total === first.total);
}
function nativeWriter(frames, first) {
  const author = first.comment.author;
  if (author === null)
    return null;
  return frames.every((frame) => frame.comment.nativeId !== null && frame.comment.author === author) ? author : null;
}
function collectPartFrames(frames) {
  const parts = new Map;
  for (const frame of frames) {
    const existing = parts.get(frame.part);
    if (existing !== undefined && (existing.data !== frame.data || existing.comment.body !== frame.comment.body))
      return { frames: parts, conflict: frame.part };
    parts.set(frame.part, frame);
  }
  return { frames: parts, conflict: null };
}
function missingPart(parts, total) {
  return parts.size !== total || [...parts.keys()].some((part) => part < 1 || part > total || !parts.has(part));
}
function decodeData(parts) {
  try {
    const encoded = [...parts.entries()].sort(([left], [right]) => left - right).map(([, frame]) => frame.data).join("");
    if (!/^[A-Za-z0-9_-]+$/.test(encoded))
      throw new Error("non-canonical base64url");
    const bytes = Buffer.from(encoded, "base64url");
    if (base64url2(bytes) !== encoded)
      throw new Error("non-canonical base64url");
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}
function nativeAuthorMatches(author, expectedAuthor, stopAuthor, kind, frames) {
  return author === expectedAuthor || author === stopAuthor && kind === "stop" && frames.every((frame) => frame.kind === "stop");
}
function headerMatchesRecord(scope, operationId, first, record) {
  return record.version === 1 && record.kind === first.kind && record.recordId === first.recordId && record.operationId === operationId && record.repository === scope.repository && record.target === scope.target;
}
function decodeParts(scope, expectedAuthor, stopAuthor, operationId, frames) {
  const parts = [...frames].sort((left, right) => left.part - right.part).map((frame) => frame.comment);
  const first = frames[0];
  if (first === undefined)
    throw new Error("decodeParts requires a frame");
  if (hasConflictingMetadata(frames, first)) {
    return invalid(operationId, first, "conflict", parts, [
      diagnostic2("conflicting-duplicate", `Operation ${operationId} repeats conflicting metadata`)
    ]);
  }
  const author = nativeWriter(frames, first);
  const frameParts = collectPartFrames(frames);
  if (frameParts.conflict !== null) {
    return invalid(operationId, first, "conflict", parts, [
      diagnostic2("conflicting-duplicate", `Operation ${operationId} has conflicting part ${frameParts.conflict}`)
    ]);
  }
  if (missingPart(frameParts.frames, first.total)) {
    return invalid(operationId, first, "incomplete", parts, [
      diagnostic2("incomplete", `Operation ${operationId} is missing required publication parts`)
    ]);
  }
  const text = decodeData(frameParts.frames);
  if (text === null) {
    return invalid(operationId, first, "invalid", parts, [
      diagnostic2("invalid-encoding", `Operation ${operationId} has non-canonical UTF-8/base64url data`)
    ]);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid(operationId, first, "invalid", parts, [
      diagnostic2("invalid-json", `Operation ${operationId} data is not JSON`)
    ]);
  }
  const parsed = parseRecord(raw);
  const headerAuthorized = author !== null && nativeAuthorMatches(author, expectedAuthor, stopAuthor, first.kind, frames);
  if (!parsed.ok) {
    return !headerAuthorized ? invalid(operationId, first, "invalid", parts, [
      diagnostic2("native-author-mismatch", `Operation ${operationId} has a wrong or inconsistent native writer`)
    ]) : invalid(operationId, first, "invalid", parts, parsed.diagnostics);
  }
  if (JSON.stringify(parsed.value) !== text) {
    return invalid(operationId, first, "invalid", parts, [diagnostic2("non-canonical-json", `Operation ${operationId} data is not canonical JSON`)], parsed.value.kind);
  }
  if (author === null || !nativeAuthorMatches(author, expectedAuthor, stopAuthor, parsed.value.kind, frames)) {
    return invalid(operationId, first, "invalid", parts, [diagnostic2("native-author-mismatch", `Operation ${operationId} has a wrong or inconsistent native writer`)], parsed.value.kind);
  }
  if (!headerMatchesRecord(scope, operationId, first, parsed.value)) {
    return invalid(operationId, first, "invalid", parts, [diagnostic2("header-metadata-mismatch", `Operation ${operationId} header metadata does not bind its record`)], parsed.value.kind);
  }
  return {
    operation: {
      operationId,
      recordId: first.recordId,
      kind: first.kind,
      status: "complete",
      parts,
      record: parsed.value
    },
    diagnostics: []
  };
}

// plugins/omp-build/adapters/github/history-codec.ts
function frameGroups() {
  return { framed: new Map, invalidFrames: new Map, legacy: [] };
}
function trustedFrame(history, comment, frame) {
  if (comment.author === history.expectedAuthor)
    return true;
  return history.stopAuthor !== null && comment.author === history.stopAuthor && frame !== null && !("diagnostic" in frame) && frame.kind === "stop";
}
function addFrame(groups, frame) {
  if ("diagnostic" in frame) {
    const key = frame.operationId === null ? `invalid:${frame.comment.locator}` : `invalid:${JSON.stringify([frame.operationId, frame.recordId, frame.kind])}`;
    const entries = groups.invalidFrames.get(key) ?? [];
    entries.push(frame);
    groups.invalidFrames.set(key, entries);
    return;
  }
  const entries = groups.framed.get(frame.operationId) ?? [];
  entries.push(frame);
  groups.framed.set(frame.operationId, entries);
}
function collectFrameGroups(history) {
  const trusted = frameGroups();
  const foreign = frameGroups();
  const trustedComments = [];
  for (const comment of history.comments) {
    const frame = frameFrom(comment);
    if (frame === null) {
      if (comment.author === history.expectedAuthor) {
        const kind = legacyKind(comment.body);
        if (kind !== null)
          trusted.legacy.push({
            operationId: null,
            recordId: null,
            kind,
            status: "legacy",
            parts: [comment],
            record: null
          });
      }
      continue;
    }
    const accepted = trustedFrame(history, comment, frame);
    if (accepted)
      trustedComments.push(comment);
    addFrame(accepted ? trusted : foreign, frame);
  }
  return { trusted, foreign, trustedComments };
}
function decodedInvalidOperations(invalidFrames) {
  const operations = [];
  const diagnostics = [];
  for (const failures of invalidFrames.values()) {
    const firstFailure = failures[0];
    if (firstFailure === undefined)
      continue;
    operations.push({
      operationId: firstFailure.operationId,
      recordId: firstFailure.recordId,
      kind: firstFailure.kind,
      status: "invalid",
      parts: failures.map((failure) => failure.comment),
      record: null
    });
    diagnostics.push(...withOperationId(failures.map((failure) => failure.diagnostic), firstFailure.operationId));
  }
  return { operations, diagnostics };
}
function decodedFramedOperations(history, framed) {
  const operations = [];
  const diagnostics = [];
  for (const [operationId, frames] of framed) {
    const decoded = decodeParts(history.scope, history.expectedAuthor, history.stopAuthor, operationId, frames);
    operations.push(decoded.operation);
    diagnostics.push(...withOperationId(decoded.diagnostics, operationId));
  }
  return { operations, diagnostics };
}
function decodedOperations(history, groups) {
  const invalid = decodedInvalidOperations(groups.invalidFrames);
  const decoded = decodedFramedOperations(history, groups.framed);
  return {
    operations: [...invalid.operations, ...decoded.operations, ...groups.legacy],
    diagnostics: [...invalid.diagnostics, ...decoded.diagnostics, ...legacyDiagnostics(groups.legacy)]
  };
}
function legacyDiagnostics(legacy) {
  return legacy.map((operation) => diagnostic2("legacy-format", `Legacy record marker at ${operation.parts[0]?.locator ?? "unknown"} cannot be admitted`));
}
function decodeHistory(history) {
  const { trusted, foreign, trustedComments } = collectFrameGroups(history);
  const trustedDecoded = decodedOperations(history, trusted);
  const foreignDecoded = decodedOperations(history, foreign);
  const clues = trustedComments.filter((comment) => comment.body.startsWith(WIRE_PREFIX)).map(looseHeaderClue);
  const authority = (operation) => {
    const claimed = withClaimedKinds(operation);
    return { ...claimed, authority: operationAuthority(claimed, history, clues) };
  };
  return {
    source: history,
    operations: [
      ...trustedDecoded.operations.map(authority),
      ...foreignDecoded.operations.map((operation) => ({
        ...withClaimedKinds(operation),
        authority: "foreign"
      }))
    ],
    diagnostics: trustedDecoded.diagnostics
  };
}
function encodeRecord(record, history, config, externalHistories = [], maxCommentBytes = 65536) {
  const parsed = parseRecord(record);
  if (!parsed.ok)
    return { ok: false, diagnostics: parsed.diagnostics };
  const projection = projectRecord(parsed.value, decodeHistory(history), config, externalHistories);
  return projection.ok ? encodeParts(parsed.value, projection.value, maxCommentBytes) : projection;
}
// plugins/omp-build/adapters/github/publisher-validation.ts
function sameOperation(record, operation) {
  const parsed = parseRecord(record);
  return parsed.ok && operation.operationId === parsed.value.operationId && operation.status === "complete" && operation.record !== null && JSON.stringify(parsed.value) === JSON.stringify(operation.record);
}
function publicationReadDiagnostics(error) {
  return error instanceof GitHubHistoryReadError ? error.diagnostics : [diagnostic2("github-read-failed", error instanceof Error ? error.message : String(error))];
}
function publicationAuthorizationDiagnostics(record, options, expectedAuthor, writer, stopAuthor) {
  if (options.writeAuthor !== undefined && options.writeAuthor !== writer) {
    return [
      diagnostic2("native-author-mismatch", `Authenticated GitHub writer ${writer} is not configured writer ${options.writeAuthor}`)
    ];
  }
  if (writer === expectedAuthor || writer === stopAuthor && stopBotMayAuthor([record.kind]))
    return null;
  return [diagnostic2("native-author-mismatch", `GitHub writer ${writer} is not authorized for ${record.kind}`)];
}
function operationConflictDiagnostics(record, sameId, incomplete) {
  if (sameId.length === incomplete.length && !incomplete.some((operation) => operation.recordId !== record.recordId || operation.kind !== record.kind)) {
    return null;
  }
  return [
    diagnostic2("operation-conflict", `Operation ${record.operationId} is already present but does not match this record`)
  ];
}
function retainedPartConflictDiagnostics(record, incomplete, expectedBodies) {
  const retainedBodies = incomplete.flatMap((operation) => operation.parts.map((part) => part.body));
  if (!retainedBodies.some((body) => !expectedBodies.has(body)))
    return null;
  return [
    diagnostic2("operation-conflict", `Operation ${record.operationId} has publication parts that differ from this record`)
  ];
}
function publicationFailure(status, history, diagnostics) {
  return { status, history, diagnostics };
}

// plugins/omp-build/adapters/github/transport.ts
function githubScope(repository, number) {
  if (!RECORD_REPOSITORY.test(repository) || !Number.isSafeInteger(number) || number < 1) {
    throw new RangeError("GitHub scope requires owner/repository and a positive issue number");
  }
  return { repository, target: `${repository}#${number}` };
}
function validateAuthors(expectedAuthor, stopAuthor) {
  if (!expectedAuthor || /\s/.test(expectedAuthor)) {
    throw new GitHubHistoryReadError("GitHub expected author is invalid", [
      diagnostic2("missing-native-author", "Expected GitHub author is absent or invalid")
    ]);
  }
  if (stopAuthor !== null && (!stopAuthor || /\s/.test(stopAuthor))) {
    throw new GitHubHistoryReadError("GitHub stop author is invalid", [
      diagnostic2("missing-native-author", "Stop GitHub author is absent or invalid")
    ]);
  }
}
async function readCommentPage(scope, number, page, options) {
  const output = await gh(options)(options.cwd, [
    "api",
    `repos/${scope.repository}/issues/${number}/comments?per_page=100&page=${page}`
  ]);
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new GitHubHistoryReadError("GitHub comment page is not JSON", [
      diagnostic2("invalid-github-response", `Comment page ${page} is not valid JSON`)
    ]);
  }
  if (!Array.isArray(parsed)) {
    throw new GitHubHistoryReadError("GitHub comment page is not an array", [
      diagnostic2("invalid-github-response", `Comment page ${page} is not an array`)
    ]);
  }
  return parsed;
}
async function readWithAuthor(scope, options, expectedAuthor, stopAuthor) {
  const number = targetNumber(scope);
  validateAuthors(expectedAuthor, stopAuthor);
  const comments = [];
  try {
    for (let page = 1;; page += 1) {
      const parsed = await readCommentPage(scope, number, page, options);
      comments.push(...parsed.map((entry, index) => parseComment(entry, scope, page, index)));
      if (parsed.length < 100)
        break;
    }
  } catch (error) {
    if (error instanceof GitHubHistoryReadError)
      throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new GitHubHistoryReadError("GitHub comments could not be read", [diagnostic2("github-read-failed", message)]);
  }
  return { scope, expectedAuthor, stopAuthor, complete: true, comments, diagnostics: [] };
}
async function readGitHubHistory(scope, options) {
  return readWithAuthor(scope, options, await expectedReadAuthor(options), options.stopAuthor ?? null);
}

// plugins/omp-build/adapters/github/publication-writer.ts
async function freshHistory(record, options, expectedAuthor, stopAuthor) {
  return decodeHistory(await readWithAuthor(record, options, expectedAuthor, stopAuthor));
}
async function postComment(record, body, options) {
  return gh(options)(options.cwd, [
    "api",
    "--method",
    "POST",
    `repos/${record.repository}/issues/${targetNumber(record)}/comments`,
    "-f",
    `body=${body}`
  ]);
}
function parsePostedComment(response, record, current) {
  try {
    return parseComment(JSON.parse(response), record, 0, 0);
  } catch (error) {
    return publicationFailure("uncertain", current, [
      diagnostic2("invalid-github-response", error instanceof Error ? error.message : String(error))
    ]);
  }
}
async function reconcileFailedPost(record, current, options, expectedAuthor, stopAuthor, error) {
  try {
    current = await freshHistory(record, options, expectedAuthor, stopAuthor);
  } catch (readError) {
    return publicationFailure("uncertain", current, publicationReadDiagnostics(readError));
  }
  const afterFailure = current.operations.find((operation) => sameOperation(record, operation));
  if (afterFailure !== undefined)
    return { status: "confirmed", operation: afterFailure };
  return publicationFailure("uncertain", current, [
    diagnostic2("github-write-uncertain", error instanceof Error ? error.message : String(error))
  ]);
}
async function rejectUnexpectedWriter(record, current, options, expectedAuthor, stopAuthor, posted, writer) {
  try {
    current = await freshHistory(record, options, expectedAuthor, stopAuthor);
  } catch (readError) {
    return publicationFailure("uncertain", current, publicationReadDiagnostics(readError));
  }
  return publicationFailure("uncertain", current, [
    diagnostic2("native-author-mismatch", `GitHub POST response writer ${posted.author ?? "unknown"} is not ${writer}`)
  ]);
}
async function publishMissingBodies(record, bodies, current, options, expectedAuthor, writer, stopAuthor) {
  const existingBodies = new Set(current.source.comments.filter((comment) => comment.author === writer).map((comment) => comment.body));
  for (const body of bodies) {
    if (existingBodies.has(body))
      continue;
    let response;
    try {
      response = await postComment(record, body, options);
    } catch (error) {
      return reconcileFailedPost(record, current, options, expectedAuthor, stopAuthor, error);
    }
    const posted = parsePostedComment(response, record, current);
    if ("status" in posted)
      return posted;
    if (posted.nativeId === null || posted.author !== writer) {
      return rejectUnexpectedWriter(record, current, options, expectedAuthor, stopAuthor, posted, writer);
    }
  }
  return null;
}

// plugins/omp-build/adapters/github/publish.ts
async function publishGitHubRecord(record, history, options, config, externalHistories = []) {
  let expectedAuthor;
  let writer;
  const stopAuthor = options.stopAuthor ?? null;
  try {
    expectedAuthor = await expectedReadAuthor(options);
    writer = options.writerLogin ?? await viewer(options);
  } catch (error) {
    return publicationFailure("uncertain", history, publicationReadDiagnostics(error));
  }
  const authorizationDiagnostics = publicationAuthorizationDiagnostics(record, options, expectedAuthor, writer, stopAuthor);
  if (authorizationDiagnostics !== null)
    return publicationFailure("refused", history, authorizationDiagnostics);
  let current;
  try {
    current = await freshHistory(record, options, expectedAuthor, stopAuthor);
  } catch (error) {
    return publicationFailure("uncertain", history, publicationReadDiagnostics(error));
  }
  const sameId = current.operations.filter((operation) => operation.operationId === record.operationId);
  const confirmed = sameId.find((operation) => sameOperation(record, operation));
  const incomplete = sameId.filter((operation) => operation.status === "incomplete");
  if (confirmed !== undefined && sameId.length === 1)
    return { status: "confirmed", operation: confirmed };
  const conflictDiagnostics = operationConflictDiagnostics(record, sameId, incomplete);
  if (conflictDiagnostics !== null)
    return publicationFailure("refused", current, conflictDiagnostics);
  const knownPartLocators = new Set(incomplete.flatMap((operation) => operation.parts.map((part) => part.locator)));
  const encodingHistory = knownPartLocators.size === 0 ? current.source : {
    ...current.source,
    comments: current.source.comments.filter((comment) => !knownPartLocators.has(comment.locator))
  };
  const encoded = encodeRecord(record, encodingHistory, config, externalHistories);
  if (!encoded.ok)
    return publicationFailure("refused", current, encoded.diagnostics);
  const retainedDiagnostics = retainedPartConflictDiagnostics(record, incomplete, new Set(encoded.value));
  if (retainedDiagnostics !== null)
    return publicationFailure("refused", current, retainedDiagnostics);
  const writeResult = await publishMissingBodies(record, encoded.value, current, options, expectedAuthor, writer, stopAuthor);
  if (writeResult !== null)
    return writeResult;
  try {
    current = await freshHistory(record, options, expectedAuthor, stopAuthor);
  } catch (error) {
    return publicationFailure("uncertain", history, publicationReadDiagnostics(error));
  }
  const readBack = current.operations.find((operation) => sameOperation(record, operation));
  return readBack === undefined ? publicationFailure("uncertain", current, [
    diagnostic2("publication-unconfirmed", `Operation ${record.operationId} was not completely confirmed by native read-back`)
  ]) : { status: "confirmed", operation: readBack };
}
// plugins/omp-build/adapters/github/record-integrity.ts
var NATIVE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
function nativeInstant(value) {
  if (typeof value !== "string" || !NATIVE_INSTANT.test(value))
    return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19))
    return null;
  return time;
}
function recordIntegrity(parts, { kind, recordId }) {
  for (const [index, part] of parts.entries()) {
    const created = nativeInstant(part.createdAt);
    const updated = nativeInstant(part.updatedAt);
    const identity = `${kind} record ${recordId} part ${index + 1}/${parts.length}`;
    if (created === null || updated === null || updated < created) {
      return {
        reason: "record-unreadable",
        detail: `${identity} has unreadable native creation/revision facts (${JSON.stringify(part.createdAt)}, ${JSON.stringify(part.updatedAt)})`
      };
    }
    if (updated !== created)
      return { reason: "record-edited", detail: `${identity} was revised after publication` };
  }
  return null;
}
function recordOperation(histories, record) {
  const scope = record.scope ?? (typeof record.repository === "string" && typeof record.target === "string" ? { repository: record.repository, target: record.target } : undefined);
  for (const history of histories) {
    if (scope !== undefined && (history.source.scope.repository !== scope.repository || history.source.scope.target !== scope.target))
      continue;
    const operation = history.operations.find((entry) => entry.record?.recordId === record.recordId && entry.record.kind === record.kind);
    if (operation !== undefined)
      return operation;
  }
  return null;
}
// plugins/omp-build/adapters/github-workflow/types.ts
var SHA = /^[0-9a-f]{40}$/;
var POSITIVE_INT = /^[1-9][0-9]*$/;
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// plugins/omp-build/adapters/github-workflow/association-validation.ts
function completeClosingIssueNodes(data, facts) {
  const repo = object(object(data)?.repository);
  const pull = object(repo?.pullRequest);
  const closing = object(pull?.closingIssuesReferences);
  const nodes = Array.isArray(closing?.nodes) ? closing.nodes : null;
  const totalCount = closing?.totalCount;
  if (pull === null || closing === null || nodes === null || typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount !== nodes.length || pull.headRefName !== facts.branch || pull.baseRefName !== facts.base || pull.headRefOid !== facts.head || pull.baseRefOid !== facts.baseTip) {
    return null;
  }
  return nodes;
}
function closingIssueNumbers(nodes) {
  const numbers = [];
  for (const node of nodes) {
    const entry = object(node);
    if (entry === null || typeof entry.number !== "number" || !Number.isSafeInteger(entry.number) || entry.number < 1) {
      return null;
    }
    numbers.push(entry.number);
  }
  return numbers;
}
function linkedIssueAssociation(data, facts, repository, pr) {
  const nodes = completeClosingIssueNodes(data, facts);
  if (nodes === null) {
    return {
      status: "incomplete",
      diagnostics: [
        diagnostic2("incomplete", `PR #${pr} closing-issue association is incomplete or conflicts with head/base facts`)
      ]
    };
  }
  if (nodes.length > 25) {
    return {
      status: "incomplete",
      diagnostics: [diagnostic2("incomplete", `PR #${pr} has more closing issues than one page can prove`)]
    };
  }
  const numbers = closingIssueNumbers(nodes);
  if (numbers === null) {
    return {
      status: "unreadable",
      diagnostics: [diagnostic2("unreadable", `PR #${pr} closing-issue node is unreadable`)]
    };
  }
  const unique = [...new Set(numbers)];
  if (unique.length === 0)
    return { status: "none" };
  if (unique.length > 1) {
    return {
      status: "ambiguous",
      diagnostics: [diagnostic2("ambiguous", `PR #${pr} closes multiple issues`, { numbers: unique })]
    };
  }
  const linked = unique[0];
  return linked === undefined ? { status: "none" } : { status: "linked", scope: githubScope(repository, linked), number: linked };
}
function issueParentAssociation(data, number) {
  const repo = object(object(data)?.repository);
  const issue = object(repo?.issue);
  if (issue === null || issue.number !== number) {
    return {
      status: "unreadable",
      diagnostics: [diagnostic2("unreadable", `Issue #${number} parent association is unreadable`)]
    };
  }
  if (!("parent" in issue) || issue.parent === null || issue.parent === undefined)
    return { status: "none" };
  const parent = object(issue.parent);
  const parentRepo = object(parent?.repository);
  const parentNumber = parent?.number;
  const parentRepository = parentRepo?.nameWithOwner;
  if (parent === null || typeof parentNumber !== "number" || !Number.isSafeInteger(parentNumber) || parentNumber < 1 || typeof parentRepository !== "string" || !RECORD_REPOSITORY.test(parentRepository)) {
    return {
      status: "unreadable",
      diagnostics: [diagnostic2("unreadable", `Issue #${number} parent payload is incomplete`)]
    };
  }
  return { status: "linked", scope: githubScope(parentRepository, parentNumber), number: parentNumber };
}

// plugins/omp-build/adapters/github-workflow/client.ts
function splitRepository(repository) {
  if (!RECORD_REPOSITORY.test(repository)) {
    throw new GitHubHistoryReadError("GitHub repository is invalid", [
      diagnostic2("invalid-scope", `Repository ${repository} is not owner/name`)
    ]);
  }
  const [owner, name] = repository.split("/");
  if (!owner || !name) {
    throw new GitHubHistoryReadError("GitHub repository is invalid", [
      diagnostic2("invalid-scope", `Repository ${repository} is not owner/name`)
    ]);
  }
  return { owner, name };
}
function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new GitHubHistoryReadError(`${label} is not JSON`, [
      diagnostic2("invalid-github-response", `${label} is not valid JSON`)
    ]);
  }
}
async function graphql(options, query, variables) {
  const raw = await gh(options)(options.cwd, [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${variables.owner}`,
    "-f",
    `name=${variables.name}`,
    "-F",
    `number=${variables.number}`
  ]);
  const parsed = object(parseJson(raw, "GitHub GraphQL response"));
  if (parsed === null) {
    throw new GitHubHistoryReadError("GitHub GraphQL response is invalid", [
      diagnostic2("invalid-github-response", "GraphQL response is not an object")
    ]);
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw new GitHubHistoryReadError("GitHub GraphQL returned errors", [
      diagnostic2("github-read-failed", "GraphQL errors prevent a complete native read", parsed.errors)
    ]);
  }
  if (!("data" in parsed) || parsed.data === null || parsed.data === undefined) {
    throw new GitHubHistoryReadError("GitHub GraphQL data is absent", [
      diagnostic2("incomplete", "GraphQL data is absent")
    ]);
  }
  return parsed.data;
}
async function resolveRepository(options, repository) {
  if (repository !== undefined) {
    if (!RECORD_REPOSITORY.test(repository)) {
      throw new GitHubHistoryReadError("GitHub repository is invalid", [
        diagnostic2("invalid-scope", `Repository ${repository} is not owner/name`)
      ]);
    }
    return repository;
  }
  const raw = await gh(options)(options.cwd, ["repo", "view", "--json", "nameWithOwner"]);
  const parsed = object(parseJson(raw, "gh repo view"));
  const nameWithOwner = parsed?.nameWithOwner;
  if (typeof nameWithOwner !== "string" || !RECORD_REPOSITORY.test(nameWithOwner)) {
    throw new GitHubHistoryReadError("GitHub repository identity is unreadable", [
      diagnostic2("unreadable", "gh repo view did not return nameWithOwner")
    ]);
  }
  return nameWithOwner;
}

// plugins/omp-build/adapters/github-workflow/native-facts.ts
function scopeNumber(scope) {
  const separator = scope.target.lastIndexOf("#");
  const repository = separator > 0 ? scope.target.slice(0, separator) : "";
  const number = separator > 0 ? Number(scope.target.slice(separator + 1)) : Number.NaN;
  if (!RECORD_REPOSITORY.test(scope.repository) || repository !== scope.repository || !Number.isSafeInteger(number) || number < 1) {
    throw new GitHubHistoryReadError("GitHub scope is invalid", [
      diagnostic2("invalid-scope", `Scope ${scope.target} is not a GitHub repository issue target`)
    ]);
  }
  return number;
}
function referenceNumber(reference) {
  if (typeof reference === "number")
    return Number.isSafeInteger(reference) && reference >= 1 ? reference : null;
  const match = /^(?:#|pr\/|issue\/)?([1-9][0-9]*)$/i.exec(reference.trim());
  if (match === null)
    return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}
async function readNativeIssueFacts(repository, number, options) {
  if (!POSITIVE_INT.test(String(number))) {
    throw new GitHubHistoryReadError("GitHub issue number is invalid", [
      diagnostic2("invalid-scope", `Issue number ${number} is invalid`)
    ]);
  }
  const raw = await gh(options)(options.cwd, ["api", `repos/${repository}/issues/${number}`]);
  const parsed = object(parseJson(raw, `issue #${number}`));
  const user = object(parsed?.user);
  const author = typeof user?.login === "string" ? user.login : null;
  const state = parsed?.state;
  const returnedNumber = parsed?.number;
  const body = parsed?.body;
  if (parsed === null || returnedNumber !== number || state !== "open" && state !== "closed" || typeof state !== "string" || typeof body !== "string") {
    throw new GitHubHistoryReadError(`Issue #${number} is unreadable`, [
      diagnostic2("unreadable", `Issue #${number} native payload is incomplete`)
    ]);
  }
  return {
    repository,
    number,
    state: state.toUpperCase(),
    author,
    body,
    isPullRequest: object(parsed.pull_request) !== null
  };
}
async function readScopeIssueBody(scope, options) {
  const facts = await readNativeIssueFacts(scope.repository, scopeNumber(scope), options);
  return facts.body;
}
async function readNativePullRequestFacts(repository, pr, options) {
  if (!POSITIVE_INT.test(String(pr))) {
    throw new GitHubHistoryReadError("GitHub pull request number is invalid", [
      diagnostic2("invalid-scope", `Pull request number ${pr} is invalid`)
    ]);
  }
  const raw = await gh(options)(options.cwd, [
    "pr",
    "view",
    String(pr),
    "--repo",
    repository,
    "--json",
    "number,state,headRefOid,headRefName,baseRefName,baseRefOid,author"
  ]);
  const parsed = object(parseJson(raw, `pull request #${pr}`));
  const authorObject = object(parsed?.author);
  const author = typeof authorObject?.login === "string" ? authorObject.login : null;
  const number = parsed?.number;
  const state = parsed?.state;
  const head = parsed?.headRefOid;
  const branch = parsed?.headRefName;
  const base = parsed?.baseRefName;
  const baseTip = parsed?.baseRefOid;
  if (number !== pr || typeof state !== "string" || typeof head !== "string" || !SHA.test(head) || typeof branch !== "string" || branch.length === 0 || typeof base !== "string" || base.length === 0 || typeof baseTip !== "string" || !SHA.test(baseTip)) {
    throw new GitHubHistoryReadError(`Pull request #${pr} is unreadable`, [
      diagnostic2("unreadable", `Pull request #${pr} native head/base facts are incomplete`)
    ]);
  }
  return { repository, pr, head, base, baseTip, branch, state, author };
}
async function resolveNativeTarget(reference, options, repository) {
  try {
    const number = referenceNumber(reference);
    if (number === null)
      return {
        status: "refused",
        diagnostics: [diagnostic2("invalid-reference", `Reference ${JSON.stringify(reference)} is not an issue or PR`)]
      };
    const resolvedRepository = await resolveRepository(options, repository);
    const issue = await readNativeIssueFacts(resolvedRepository, number, options);
    if (!issue.isPullRequest)
      return { status: "issue", scope: githubScope(resolvedRepository, number), issue };
    const pullRequest = await readNativePullRequestFacts(resolvedRepository, number, options);
    return { status: "pull-request", scope: githubScope(resolvedRepository, number), pullRequest };
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) {
      const codes = new Set(error.diagnostics.map((entry) => entry.code));
      return {
        status: codes.has("incomplete") ? "incomplete" : codes.has("ambiguous") ? "ambiguous" : "unreadable",
        diagnostics: error.diagnostics
      };
    }
    return {
      status: "unreadable",
      diagnostics: [diagnostic2("github-read-failed", error instanceof Error ? error.message : String(error))]
    };
  }
}
async function resolveNativeScope(scope, options) {
  try {
    return await resolveNativeTarget(scopeNumber(scope), options, scope.repository);
  } catch (error) {
    if (error instanceof GitHubHistoryReadError)
      return { status: "refused", diagnostics: error.diagnostics };
    return {
      status: "unreadable",
      diagnostics: [diagnostic2("github-read-failed", error instanceof Error ? error.message : String(error))]
    };
  }
}

// plugins/omp-build/adapters/github-workflow/associations.ts
var CLOSING_ISSUES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefName
      baseRefName
      headRefOid
      baseRefOid
      closingIssuesReferences(first: 25) { totalCount nodes { number } }
    }
  }
}`;
var PARENT_ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { number parent { number repository { nameWithOwner } } }
  }
}`;
async function readLinkedIssueAssociation(repository, pr, options) {
  try {
    const { owner, name } = splitRepository(repository);
    const pullFacts = await readNativePullRequestFacts(repository, pr, options);
    const data = await graphql(options, CLOSING_ISSUES_QUERY, { owner, name, number: pr });
    return linkedIssueAssociation(data, pullFacts, repository, pr);
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) {
      return { status: "unreadable", diagnostics: error.diagnostics };
    }
    return {
      status: "unreadable",
      diagnostics: [diagnostic2("github-read-failed", error instanceof Error ? error.message : String(error))]
    };
  }
}
async function readIssueParentAssociation(repository, number, options) {
  try {
    const { owner, name } = splitRepository(repository);
    const data = await graphql(options, PARENT_ISSUE_QUERY, { owner, name, number });
    return issueParentAssociation(data, number);
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) {
      return { status: "unreadable", diagnostics: error.diagnostics };
    }
    return {
      status: "unreadable",
      diagnostics: [diagnostic2("github-read-failed", error instanceof Error ? error.message : String(error))]
    };
  }
}
// plugins/omp-build/engine/workflow-control.ts
var WORKTREE_ACTIONS = new Set([
  "frame",
  "assess-spec",
  "plan",
  "implement",
  "publish",
  "review",
  "fix",
  "attribute-ci",
  "epic-next",
  "epic-final",
  "mark-fix",
  "hook",
  "report"
]);
function refused(reason, evidence) {
  return { status: "refused", reason, evidence };
}
function recordsOf(history) {
  const records = [];
  const seen = new Set;
  for (const operation of history.operations) {
    if (operation.status !== "complete" || operation.record === null || operation.authority === "foreign")
      continue;
    if (seen.has(operation.record.recordId))
      continue;
    seen.add(operation.record.recordId);
    records.push(operation.record);
  }
  return records;
}
function workflowOperationProblem(history) {
  if (!history.source.complete)
    return "incomplete";
  for (const operation of history.operations) {
    const kind = operation.record?.kind ?? operation.kind;
    if (!isWorkflowKind(kind ?? "") && !operation.claimedKinds.some((claim) => isWorkflowKind(claim)))
      continue;
    if (operation.status === "conflict")
      return "ambiguous";
    if (operation.status === "incomplete" || operation.status === "invalid" || operation.status === "legacy")
      return "unconfirmed";
    if (operation.authority === "foreign")
      return "unconfirmed";
  }
  return null;
}
function bindExternalRef(ref, foreignHistory) {
  if (!equalScope(ref.scope, foreignHistory.source.scope))
    return fail([
      diagnostic("missing-history", `No history was supplied for ${ref.scope.repository} ${ref.scope.target}`)
    ]);
  if (!foreignHistory.source.complete)
    return fail([diagnostic("incomplete", "External history pagination is incomplete")]);
  const matches = foreignHistory.operations.filter((operation) => operation.recordId === ref.recordId || operation.record?.recordId === ref.recordId);
  if (matches.length === 0)
    return fail([diagnostic("unknown", `Record ${ref.recordId} is not in the foreign history`)]);
  if (matches.some((operation) => operation.status === "conflict"))
    return fail([diagnostic("conflict", `Record ${ref.recordId} has conflicting parts`)]);
  if (matches.some((operation) => operation.status !== "complete" || operation.record === null))
    return fail([diagnostic("unconfirmed", `Record ${ref.recordId} is not a complete authenticated record`)]);
  if (matches.some((operation) => operation.authority === "foreign"))
    return fail([diagnostic("foreign", `Record ${ref.recordId} is not from the expected author`)]);
  const bodies = matches.map((operation) => JSON.stringify(operation.record));
  if (new Set(bodies).size !== 1)
    return fail([diagnostic("ambiguous", `Record ${ref.recordId} has incompatible duplicates`)]);
  const record = matches[0]?.record;
  if (record === null || record === undefined)
    return fail([diagnostic("unconfirmed", `Record ${ref.recordId} has no body`)]);
  if (record.kind !== ref.kind)
    return fail([diagnostic("kind-mismatch", `Record ${ref.recordId} is ${record.kind}, not ${ref.kind}`)]);
  return { ok: true, value: record };
}
function historyFor(scope, histories) {
  return histories.find((history) => equalScope(history.source.scope, scope)) ?? null;
}
function controlsOf(history) {
  return recordsOf(history).filter((record) => record.kind === "operator-control");
}
function mandatesOf(history) {
  return recordsOf(history).filter((record) => record.kind === "mandate");
}
function pauseRequestFor(mandate, record) {
  return record.payload.control === "pause-requested" && sameRef(record.payload.mandate, { scope: mandateScope(mandate), recordId: mandate.recordId, kind: "mandate" });
}
function pauseConfirmationFor(history, mandate, request) {
  const requestRef = {
    scope: { repository: request.repository, target: request.target },
    recordId: request.recordId,
    kind: "operator-control"
  };
  return controlsOf(history).find((record) => record.payload.control === "pause-confirmed" && record.payload.controlId === request.payload.controlId && sameRef(record.payload.mandate, {
    scope: mandateScope(mandate),
    recordId: mandate.recordId,
    kind: "mandate"
  }) && record.payload.predecessor !== null && sameRef(record.payload.predecessor, requestRef) && record.payload.disarm.observed === true) ?? null;
}
function confirmedPause(history, mandate) {
  for (const request of controlsOf(history)) {
    if (!pauseRequestFor(mandate, request))
      continue;
    const confirmation = pauseConfirmationFor(history, mandate, request);
    if (confirmation !== null)
      return confirmation;
  }
  return null;
}
function unliftedPause(history, mandate) {
  for (const request of controlsOf(history)) {
    if (!pauseRequestFor(mandate, request))
      continue;
    const confirmation = pauseConfirmationFor(history, mandate, request);
    if (confirmation !== null && !pauseLifted(history, confirmation))
      return confirmation;
  }
  return null;
}
function outstandingPauseRequest(history, mandate) {
  return controlsOf(history).find((record) => pauseRequestFor(mandate, record) && pauseConfirmationFor(history, mandate, record) === null) ?? null;
}
function outstandingPauseInAuthority(mandate, histories, seen = new Set) {
  const scope = mandateScope(mandate);
  const key = `${scope.repository}\x00${scope.target}\x00${mandate.recordId}`;
  if (seen.has(key))
    return null;
  const home = historyFor(scope, histories);
  if (home === null)
    return null;
  if (outstandingPauseRequest(home, mandate) !== null)
    return diagnostic("pause-unconfirmed", `Mandate ${mandate.recordId} has an unconfirmed pause request`);
  if (mandate.payload.parent === null)
    return null;
  const parentHistory = historyFor(mandate.payload.parent.scope, histories);
  if (parentHistory === null)
    return null;
  const parent = bindExternalRef(mandate.payload.parent, parentHistory);
  if (!parent.ok || parent.value.kind !== "mandate")
    return null;
  const nextSeen = new Set(seen);
  nextSeen.add(key);
  return outstandingPauseInAuthority(parent.value, histories, nextSeen);
}
function pauseLifted(history, confirmation) {
  if (confirmation.payload.control !== "pause-confirmed")
    return false;
  return controlsOf(history).some((record) => record.payload.control === "resume" && record.payload.controlId === confirmation.payload.controlId && sameRef(record.payload.mandate, confirmation.payload.mandate) && sameRef(record.payload.predecessor, {
    scope: { repository: confirmation.repository, target: confirmation.target },
    recordId: confirmation.recordId,
    kind: "operator-control"
  }));
}
function mandateScope(record) {
  return { repository: record.repository, target: record.target };
}
function abandoned(history, mandate) {
  const mandateRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: "mandate" };
  return controlsOf(history).some((record) => record.payload.control === "abandon" && sameRef(record.payload.mandate, mandateRef));
}
function successorOf(history, mandate) {
  const mandateRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: "mandate" };
  const control = controlsOf(history).find((record) => record.payload.control === "select-successor" && sameRef(record.payload.predecessor, mandateRef));
  return control?.payload.control === "select-successor" ? control.payload.successor : null;
}
function epicFixScopes(histories, run) {
  const scopes = [];
  for (const history of histories) {
    for (const record of recordsOf(history)) {
      if (record.kind !== "epic-event" || record.runId !== run)
        continue;
      if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload))
        continue;
      if (Reflect.get(record.payload, "event") !== "epic-fix")
        continue;
      scopes.push({ repository: record.repository, target: record.target });
    }
  }
  return scopes;
}
function childPermitted(parent, childScope, histories) {
  if (parent.payload.role !== "epic")
    return false;
  if (parent.payload.children.some((child) => equalScope(child.scope, childScope)))
    return true;
  return epicFixScopes(histories, parent.payload.run).some((scope) => equalScope(scope, childScope));
}

// plugins/omp-build/engine/workflow-pr-binding-chain.ts
function bindingRefusal(status, diagnostics) {
  return { status, diagnostics };
}
function refKey(ref) {
  return `${ref.kind}\x00${ref.scope.repository}\x00${ref.scope.target}\x00${ref.recordId}`;
}
function claimsBinding(operation) {
  return operation.kind === "workflow-binding" || operation.claimedKinds.includes("workflow-binding") || operation.record?.kind === "workflow-binding";
}
function successorClaim(history, mandate) {
  const controls = history.operations.filter((operation) => operation.record?.kind === "operator-control" && operation.record.payload.control === "select-successor" && sameRef(operation.record.payload.predecessor, mandate));
  if (controls.length === 0)
    return { status: "none" };
  if (controls.some((operation) => operation.status !== "complete" || operation.authority !== "accounted" || operation.record === null)) {
    return bindingRefusal("incomplete", [
      diagnostic("unconfirmed", "A select-successor claim does not confirm an authorized binding chain")
    ]);
  }
  const refs = controls.flatMap((operation) => operation.record?.kind === "operator-control" && operation.record.payload.control === "select-successor" ? [operation.record.payload.successor] : []);
  const first = refs[0];
  if (first === undefined || first.kind !== "mandate" || refs.some((ref) => !sameRef(ref, first))) {
    return bindingRefusal("conflicting", [
      diagnostic("conflicting", "Select-successor controls do not name one mandate")
    ]);
  }
  return { status: "next", ref: first };
}
function uniqueBindings(bindings) {
  const byMandate = new Map;
  for (const binding of bindings) {
    const key = refKey(binding.payload.mandate);
    const prior = byMandate.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(binding)) {
      return bindingRefusal("conflicting", [
        diagnostic("conflicting", "Multiple workflow bindings name the same mandate")
      ]);
    }
    byMandate.set(key, binding);
  }
  return [...byMandate.values()];
}
function successors(bindings, histories) {
  const next = new Map;
  for (const binding of bindings) {
    const home = historyFor(binding.payload.mandate.scope, histories);
    if (home === null || !home.source.complete) {
      return bindingRefusal("incomplete", [
        diagnostic("incomplete", "Binding mandate history is missing or incomplete")
      ]);
    }
    const successor = successorClaim(home, binding.payload.mandate);
    if (successor.status === "incomplete" || successor.status === "conflicting")
      return successor;
    if (successor.status === "next") {
      const key = refKey(successor.ref);
      if (!bindings.some((candidate) => refKey(candidate.payload.mandate) === key)) {
        return bindingRefusal("incomplete", [
          diagnostic("unconfirmed", "Authorized successor has no workflow-binding on this PR")
        ]);
      }
      next.set(refKey(binding.payload.mandate), key);
    }
  }
  return next;
}
function authorizedHead(bindings, next) {
  const heads = bindings.filter((binding) => !next.has(refKey(binding.payload.mandate)));
  const head = heads[0];
  if (heads.length !== 1 || head === undefined) {
    return bindingRefusal("conflicting", [
      diagnostic("conflicting", "Workflow bindings do not form one authorized chain")
    ]);
  }
  return head;
}
function onAuthorizedChain(bindings, next, head) {
  const headKey = refKey(head.payload.mandate);
  for (const binding of bindings) {
    let cursor = refKey(binding.payload.mandate);
    const seen = new Set;
    while (cursor !== headKey) {
      if (seen.has(cursor))
        return bindingRefusal("conflicting", [diagnostic("conflicting", "Workflow binding successor chain cycles")]);
      seen.add(cursor);
      const step = next.get(cursor);
      if (step === undefined) {
        return bindingRefusal("conflicting", [
          diagnostic("conflicting", "Workflow binding is outside the authorized chain")
        ]);
      }
      cursor = step;
    }
  }
  return null;
}
function resolveBindingChain(bindings, histories) {
  const unique = uniqueBindings(bindings);
  if (!Array.isArray(unique))
    return unique;
  const next = successors(unique, histories);
  if (!(next instanceof Map))
    return next;
  const head = authorizedHead(unique, next);
  if ("status" in head)
    return head;
  const refusal = onAuthorizedChain(unique, next, head);
  if (refusal !== null)
    return refusal;
  return { status: "bound", binding: head };
}
function invalidClaims(claims) {
  if (claims.some((operation) => operation.authority === "foreign")) {
    return bindingRefusal("conflicting", [diagnostic("foreign", "A foreign workflow-binding is not an absent mandate")]);
  }
  if (claims.some((operation) => operation.status === "conflict")) {
    return bindingRefusal("conflicting", [diagnostic("conflicting", "Workflow-binding parts conflict")]);
  }
  if (claims.some((operation) => operation.status !== "complete" || operation.authority !== "accounted" || operation.record === null)) {
    return bindingRefusal("incomplete", [
      diagnostic("incomplete", "A workflow-binding claim is not a complete accounted record")
    ]);
  }
  return null;
}
function validatedBindingClaim(operation, input) {
  const record = operation.record;
  if (record === null || record.kind !== "workflow-binding")
    return bindingRefusal("conflicting", [diagnostic("malformed", "Workflow-binding claim has no binding record")]);
  if (!equalScope({ repository: record.repository, target: record.target }, input.pullRequest)) {
    return bindingRefusal("conflicting", [
      diagnostic("unknown-binding", "Workflow-binding scope is not the pull request")
    ]);
  }
  if (record.payload.mandate.kind !== "mandate")
    return bindingRefusal("conflicting", [diagnostic("kind-mismatch", "Workflow binding must name a mandate")]);
  if (record.payload.branch !== input.native.branch || record.payload.base !== input.native.base) {
    return bindingRefusal("conflicting", [
      diagnostic("native-mismatch", "Workflow-binding branch or base does not match the PR")
    ]);
  }
  return record;
}
function appendDistinctBinding(records, record) {
  const prior = records.find((item) => item.recordId === record.recordId);
  if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(record))
    return bindingRefusal("conflicting", [diagnostic("conflicting", "Workflow binding has incompatible duplicates")]);
  if (prior === undefined)
    records.push(record);
  return null;
}
function recordsForClaims(claims, input) {
  const records = [];
  for (const operation of claims) {
    const record = validatedBindingClaim(operation, input);
    if ("status" in record)
      return record;
    const duplicate = appendDistinctBinding(records, record);
    if (duplicate !== null)
      return duplicate;
  }
  return records;
}
function selectWorkflowBindingCandidate(input) {
  const history = historyFor(input.pullRequest, input.histories);
  if (history === null)
    return bindingRefusal("incomplete", [diagnostic("missing-history", "Pull request history is missing")]);
  if (!history.source.complete)
    return bindingRefusal("incomplete", [diagnostic("incomplete", "Pull request history is incomplete")]);
  const claims = history.operations.filter(claimsBinding);
  if (claims.length === 0)
    return { status: "absent" };
  const invalid = invalidClaims(claims);
  if (invalid !== null)
    return invalid;
  const records = recordsForClaims(claims, input);
  if (!Array.isArray(records))
    return records;
  return resolveBindingChain(records, input.histories);
}

// plugins/omp-build/engine/workflow-pr-binding.ts
function confirmedAccountedMandate(history, ref) {
  const matches = history.operations.filter((operation) => operation.status === "complete" && operation.authority === "accounted" && operation.record?.kind === "mandate" && operation.record.recordId === ref.recordId && equalScope({ repository: operation.record.repository, target: operation.record.target }, ref.scope));
  const bodies = matches.map((operation) => JSON.stringify(operation.record));
  if (matches.length === 0 || new Set(bodies).size !== 1)
    return null;
  const record = matches[0]?.record;
  return record?.kind === "mandate" ? record : null;
}
function selectWorkflowBinding(input) {
  const chained = selectWorkflowBindingCandidate(input);
  if (chained.status !== "bound")
    return chained;
  const home = historyFor(chained.binding.payload.mandate.scope, input.histories);
  if (home === null || !home.source.complete) {
    return {
      status: "incomplete",
      diagnostics: [diagnostic("incomplete", "Binding mandate history is missing or incomplete")]
    };
  }
  const mandateRecord = confirmedAccountedMandate(home, chained.binding.payload.mandate);
  if (mandateRecord === null) {
    return {
      status: "incomplete",
      diagnostics: [diagnostic("incomplete", "Binding mandate record is not confirmed")]
    };
  }
  return {
    status: "bound",
    binding: chained.binding,
    mandate: chained.binding.payload.mandate,
    mandateRecord
  };
}

// plugins/omp-build/adapters/github-workflow/binding-resolution.ts
function bindingRefusal2(status, diagnostics, evidence) {
  return evidence === undefined ? { ok: false, status, reason: status, diagnostics } : { ok: false, status, reason: status, diagnostics, evidence };
}
function initialBindingSelection(prScope, prHistory, mandateHistories, pullRequest) {
  return selectWorkflowBinding({
    pullRequest: prScope,
    histories: [prHistory, ...mandateHistories],
    native: { branch: pullRequest.branch, base: pullRequest.base }
  });
}
async function readBindingMandateHistories(prHistory, options) {
  const histories = [];
  for (const operation of prHistory.operations) {
    const record = operation.record;
    if (record?.kind !== "workflow-binding")
      continue;
    const mandateScope = record.payload.mandate.scope;
    if (historyFor(mandateScope, [prHistory, ...histories]) !== null)
      continue;
    const history = decodeHistory(await readGitHubHistory(mandateScope, options));
    if (!history.source.complete) {
      return {
        ok: false,
        result: bindingRefusal2("incomplete", [diagnostic2("incomplete", "Binding mandate history is incomplete")])
      };
    }
    histories.push(history);
  }
  return { ok: true, histories };
}
async function resolveInitialWorkflowBinding(prScope, options) {
  const pr = scopeNumber(prScope);
  const pullRequest = await readNativePullRequestFacts(prScope.repository, pr, options);
  const prHistory = decodeHistory(await readGitHubHistory(prScope, options));
  if (!prHistory.source.complete) {
    return { ok: false, result: bindingRefusal2("incomplete", [diagnostic2("incomplete", "PR history is incomplete")]) };
  }
  let mandateHistories = [];
  let selected = initialBindingSelection(prScope, prHistory, mandateHistories, pullRequest);
  if (selected.status === "incomplete") {
    const fetched = await readBindingMandateHistories(prHistory, options);
    if (!fetched.ok)
      return { ok: false, result: fetched.result };
    mandateHistories = fetched.histories;
    selected = initialBindingSelection(prScope, prHistory, mandateHistories, pullRequest);
  }
  if (selected.status !== "bound") {
    return {
      ok: false,
      result: bindingRefusal2(selected.status, selected.status === "absent" ? [diagnostic2("absent", "PR has no workflow-binding")] : selected.diagnostics)
    };
  }
  return { ok: true, pullRequest, prHistory, mandateHistories, selected };
}
async function readParentMandateChain(mandate, knownHistories, options) {
  const parentScopes = [];
  const parentHistories = [];
  const seenParents = new Set;
  let parent = mandate.payload.parent;
  while (parent !== null) {
    if (parent.kind !== "mandate") {
      return {
        ok: false,
        result: bindingRefusal2("conflicting", [diagnostic2("kind-mismatch", "Mandate parent is not a mandate")])
      };
    }
    const key = refKey(parent);
    if (seenParents.has(key)) {
      return {
        ok: false,
        result: bindingRefusal2("conflicting", [diagnostic2("conflicting", "Mandate parent chain cycles")])
      };
    }
    seenParents.add(key);
    let parentHistory = historyFor(parent.scope, [...knownHistories, ...parentHistories]);
    if (parentHistory === null) {
      parentHistory = decodeHistory(await readGitHubHistory(parent.scope, options));
      if (!parentHistory.source.complete) {
        return {
          ok: false,
          result: bindingRefusal2("incomplete", [diagnostic2("incomplete", "Parent mandate history is incomplete")])
        };
      }
      parentHistories.push(parentHistory);
    }
    const parentRecord = confirmedAccountedMandate(parentHistory, parent);
    if (parentRecord === null) {
      return {
        ok: false,
        result: bindingRefusal2("incomplete", [diagnostic2("incomplete", "Parent mandate record is not confirmed")])
      };
    }
    parentScopes.push(parent.scope);
    parent = parentRecord.payload.parent;
  }
  return { ok: true, parentScopes, parentHistories };
}
function uniqueHistories(histories) {
  const unique = [];
  for (const history of histories) {
    if (unique.some((existing) => equalScope(existing.source.scope, history.source.scope)))
      continue;
    unique.push(history);
  }
  return unique;
}

// plugins/omp-build/adapters/github-workflow/binding.ts
async function readWorkflowBinding(prScope, options) {
  try {
    const resolved = await resolveInitialWorkflowBinding(prScope, options);
    if (!resolved.ok)
      return resolved.result;
    const { pullRequest, prHistory, mandateHistories, selected } = resolved;
    const mandateHistory = historyFor(selected.mandate.scope, [prHistory, ...mandateHistories]);
    if (mandateHistory === null) {
      return bindingRefusal2("incomplete", [diagnostic2("incomplete", "Binding mandate history is missing")]);
    }
    const parentResolution = await readParentMandateChain(selected.mandateRecord, [prHistory, ...mandateHistories], options);
    if (!parentResolution.ok)
      return parentResolution.result;
    let body;
    try {
      body = await readScopeIssueBody(selected.mandate.scope, options);
    } catch (error) {
      const diagnostics = error instanceof GitHubHistoryReadError ? error.diagnostics : [diagnostic2("unreadable", error instanceof Error ? error.message : String(error))];
      return bindingRefusal2("unreadable", diagnostics, { scope: selected.mandate.scope });
    }
    return {
      ok: true,
      value: {
        binding: selected.binding,
        history: mandateHistory,
        histories: uniqueHistories([prHistory, ...mandateHistories, ...parentResolution.parentHistories]),
        linkedIssueBodies: [{ scope: selected.mandate.scope, body }],
        parentScopes: parentResolution.parentScopes,
        native: {
          branch: pullRequest.branch,
          base: pullRequest.base,
          pullRequest: prScope,
          linkedIssueScopes: [selected.mandate.scope]
        },
        observed: { head: pullRequest.head, baseTip: pullRequest.baseTip }
      }
    };
  } catch (error) {
    const diagnostics = error instanceof GitHubHistoryReadError ? error.diagnostics : [diagnostic2("github-read-failed", error instanceof Error ? error.message : String(error))];
    return bindingRefusal2("unreadable", diagnostics);
  }
}
async function readLandingFacts(prScope, options) {
  const bound = await readWorkflowBinding(prScope, options);
  if (!bound.ok) {
    return {
      ok: false,
      reason: bound.reason === "unconfirmed" ? "unconfirmed" : bound.reason,
      diagnostics: bound.diagnostics,
      evidence: bound.evidence
    };
  }
  return {
    ok: true,
    histories: bound.value.histories,
    native: bound.value.native,
    observed: bound.value.observed,
    linkedIssueBodies: bound.value.linkedIssueBodies,
    parentScopes: bound.value.parentScopes,
    binding: bound.value.binding
  };
}
async function publishConfirmedWorkflowRecord(record, history, options, config, externalHistories = []) {
  return publishGitHubRecord(record, history, options, config, externalHistories);
}
// plugins/omp-build/adapters/github-workflow/history.ts
function incompleteOperationDiagnostic(history, operation) {
  if (operation.status !== "incomplete" && operation.status !== "conflict")
    return null;
  return diagnostic2(operation.status === "incomplete" ? "incomplete" : "ambiguous", `Operation ${operation.operationId ?? "unknown"} on ${history.source.scope.target} is ${operation.status}`);
}
function appendCompleteRecord(record, collection) {
  const existing = collection.byRecordId.get(record.recordId);
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
    collection.diagnostics.push(diagnostic2("ambiguous", `Record ${record.recordId} has conflicting complete publications across scopes`));
    return;
  }
  if (existing === undefined) {
    collection.byRecordId.set(record.recordId, record);
    collection.records.push(record);
  }
}
function collectCompleteHistoryOperations(history, collection) {
  for (const operation of history.operations) {
    if (operation.authority === "foreign")
      continue;
    const incomplete = incompleteOperationDiagnostic(history, operation);
    if (incomplete !== null) {
      collection.diagnostics.push(incomplete);
      continue;
    }
    if (operation.status !== "complete" || operation.record === null)
      continue;
    appendCompleteRecord(operation.record, collection);
  }
}
function collectRecords(histories) {
  const collection = { records: [], diagnostics: [], byRecordId: new Map };
  for (const history of histories) {
    if (!history.source.complete) {
      collection.diagnostics.push(diagnostic2("incomplete", `History for ${history.source.scope.target} is not a complete native read`));
      continue;
    }
    collectCompleteHistoryOperations(history, collection);
    collection.diagnostics.push(...history.diagnostics);
  }
  return collection;
}
async function readComposedWorkflowHistory(scopes, options) {
  if (scopes.length === 0) {
    return {
      ok: false,
      reason: "incomplete",
      diagnostics: [diagnostic2("incomplete", "Composed workflow history requires at least one scope")],
      histories: []
    };
  }
  if (new Set(scopes.map((scope) => scope.target)).size !== scopes.length) {
    return {
      ok: false,
      reason: "ambiguous",
      diagnostics: [diagnostic2("ambiguous", "Composed workflow history received duplicate scopes")],
      histories: []
    };
  }
  const histories = [];
  try {
    for (const scope of scopes) {
      const source = await readGitHubHistory(scope, options);
      if (!source.complete) {
        return {
          ok: false,
          reason: "incomplete",
          diagnostics: [diagnostic2("incomplete", `Native history for ${scope.target} is incomplete`)],
          histories,
          evidence: { scope }
        };
      }
      histories.push(decodeHistory(source));
    }
  } catch (error) {
    const diagnostics = error instanceof GitHubHistoryReadError ? error.diagnostics : [diagnostic2("github-read-failed", error instanceof Error ? error.message : String(error))];
    return { ok: false, reason: "unreadable", diagnostics, histories };
  }
  const collected = collectRecords(histories);
  const blocking = collected.diagnostics.filter((entry) => entry.code === "incomplete" || entry.code === "ambiguous" || entry.code === "conflicting-duplicate");
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: blocking.some((entry) => entry.code === "ambiguous" || entry.code === "conflicting-duplicate") ? "ambiguous" : "incomplete",
      diagnostics: collected.diagnostics,
      histories
    };
  }
  return { ok: true, scopes: [...scopes], histories, records: collected.records };
}
// plugins/omp-build/engine/history-schema.ts
var historySchema = strictObject({
  scope: scopeSchema,
  expectedAuthor: string2().min(1),
  stopAuthor: string2().min(1).nullable(),
  complete: boolean2(),
  comments: array(observedCommentSchema),
  diagnostics: array(diagnosticSchema)
});
var operationAuthoritySchema = _enum(["authority", "foreign", "accounted"]);
var operationReadSchema = strictObject({
  operationId: string2().min(1).nullable(),
  recordId: string2().min(1).nullable(),
  kind: string2().min(1).nullable(),
  status: _enum(["complete", "incomplete", "conflict", "invalid", "legacy"]),
  parts: array(observedCommentSchema),
  record: recordSchema.nullable(),
  claimedKinds: array(string2().min(1)).refine((kinds) => new Set(kinds).size === kinds.length, "claimed kinds must be distinct"),
  authority: operationAuthoritySchema
});
var decodedHistorySchema = strictObject({
  source: historySchema,
  operations: array(operationReadSchema),
  diagnostics: array(diagnosticSchema)
});
// plugins/omp-build/engine/review-conservation.ts
function originalEntriesForRoot(records, rootAttemptId) {
  const entries = [];
  for (const record of records.values()) {
    if (record.kind !== "contribution" || record.payload.content !== "findings" || record.payload.host.phase !== "panel" || record.payload.inventoryId === null || record.payload.findings === null)
      continue;
    const inventory = records.get(record.payload.inventoryId);
    if (inventory?.kind !== "review-attempt" || inventory.payload.rootAttemptId !== rootAttemptId)
      continue;
    for (const original of record.payload.findings)
      entries.push({ id: original.id, data: original.data, contribution: record.payload });
  }
  return entries;
}
function indexRecallClass(classes, classId, entry, callsites) {
  const indexed = classes.get(classId) ?? {
    chunks: new Set,
    callsites: new Map,
    sourceFindingIds: new Set
  };
  if (entry.contribution.host.chunk !== null)
    indexed.chunks.add(entry.contribution.host.chunk);
  for (const callsite of callsites)
    indexed.callsites.set(`${callsite.file}:${callsite.line}`, callsite);
  indexed.sourceFindingIds.add(entry.id);
  classes.set(classId, indexed);
}
function recallClasses(entries, canonicalClasses) {
  const classes = new Map;
  for (const entry of entries) {
    const inspected = inspectFinding(entry.data, canonicalClasses);
    if (!inspected.usable)
      continue;
    const finding = findingSchema.parse(entry.data);
    for (const classId of finding.classes ?? []) {
      if (!canonicalClasses.includes(classId) || classId.startsWith("candidate/"))
        continue;
      indexRecallClass(classes, classId, entry, finding.rawCallsites ?? []);
    }
  }
  return classes;
}
function recallIndex(classes) {
  return [...classes.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([classId, value]) => ({
    classId,
    chunks: [...value.chunks].sort((left, right) => left - right),
    callsites: [...value.callsites.values()].sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line),
    sourceFindingIds: [...value.sourceFindingIds].sort()
  }));
}
function deriveRecallPlan(history, rootAttemptId, canonicalClasses) {
  const graph = validateRecordGraph(history);
  if (!graph.ok)
    return fail(graph.diagnostics);
  const records = new Map(graph.value.map((record) => [record.recordId, record]));
  const root = records.get(rootAttemptId);
  if (root?.kind !== "review-attempt" || root.payload.stage !== "initial" || root.payload.purpose !== "review")
    return fail([diagnostic("unknown-reference", `Recall root ${rootAttemptId} is not an initial review inventory`)]);
  const closureDiagnostics = [];
  requiredSlotsComplete(records, root, closureDiagnostics, true);
  if (closureDiagnostics.length > 0)
    return fail(closureDiagnostics);
  const index = recallIndex(recallClasses(originalEntriesForRoot(records, rootAttemptId), canonicalClasses));
  return {
    ok: true,
    value: {
      index,
      triggeredClassIds: index.filter((entry) => entry.chunks.length >= 2 && entry.callsites.length >= 3).map((entry) => entry.classId),
      diagnostics: []
    }
  };
}
// plugins/omp-build/engine/review-history.ts
function spentBeforeCurrentPullRequestAttempt(history, taxonomy, acceptedPolicyRef) {
  const root = latestUnfinishedPullRequestRoot(recordMap(history));
  if (root === null)
    return null;
  const rootIndex = history.operations.findIndex((operation) => operation.status === "complete" && operation.record?.recordId === root.recordId);
  if (rootIndex === -1)
    return null;
  const prefix = {
    ...history,
    source: { ...history.source, complete: true, diagnostics: [] },
    operations: history.operations.slice(0, rootIndex),
    diagnostics: []
  };
  return spentInCompleteHistory(prefix, taxonomy, acceptedPolicyRef);
}
function spentInCompleteHistory(history, taxonomy, acceptedPolicyRef) {
  const completedHistory = {
    ...history,
    source: { ...history.source, complete: true, diagnostics: [] },
    operations: history.operations.filter((operation) => operation.status === "complete" && operation.record !== null),
    diagnostics: []
  };
  const graph = validateRecordGraph(completedHistory);
  if (!graph.ok)
    return null;
  const records = new Map(graph.value.map((record) => [record.recordId, record]));
  if ([...records.values()].some((record) => record.kind === "stop"))
    return true;
  const reviews = reviewOperations(completedHistory);
  for (const [index, operation] of reviews.entries()) {
    if (index < 2 || operation.record?.kind !== "review")
      continue;
    const decision = records.get(operation.record.payload.decisionId);
    if (decision?.kind !== "decision")
      return null;
    const assessment = validateDecision2(decision, completedHistory, taxonomy, acceptedPolicyRef);
    if (!assessment.admissible)
      return null;
    if (assessment.verdict === "Request changes")
      return true;
  }
  return false;
}

// plugins/omp-build/engine/review-attempt-operations.ts
function reviewAttemptReferences(record) {
  const references = [...record.inputs];
  if (record.kind === "review")
    references.push(...record.payload.inventoryIds, record.payload.decisionId);
  if (record.kind === "decision")
    references.push(record.payload.originalContributionId, ...record.payload.judgment.sourceContributionIds);
  if (record.kind === "contribution" && record.payload.inventoryId !== null)
    references.push(record.payload.inventoryId);
  return references;
}
function collectReviewOperations(history, selected, reviewId, recordId, operations, visiting) {
  if (operations.has(recordId))
    return true;
  if (visiting.has(recordId))
    return false;
  visiting.add(recordId);
  const operation = recordId === reviewId ? selected : history.operations.find((candidate) => candidate.record?.recordId === recordId);
  if (operation?.record === null || operation === undefined)
    return false;
  operations.set(recordId, operation);
  for (const reference of reviewAttemptReferences(operation.record))
    if (!collectReviewOperations(history, selected, reviewId, reference, operations, visiting))
      return false;
  visiting.delete(recordId);
  return true;
}
function selectedReviewOperations(history, summary) {
  if (summary.reviewId === null)
    return [];
  const selected = reviewOperations(history).find((operation) => operation.record?.recordId === summary.reviewId);
  const review = selected?.record;
  if (review?.kind !== "review" || selected === undefined)
    return null;
  const operations = new Map;
  return collectReviewOperations(history, selected, review.recordId, review.recordId, operations, new Set) ? [...operations.values()] : null;
}

// plugins/omp-build/engine/review-state.ts
function summarizeReviews(history, taxonomy, acceptedPolicyRef) {
  return summarizeAuthorityReviews(classifyHistory(history).authorityHistory, taxonomy, acceptedPolicyRef);
}
function summaryFailure(diagnostics, knownReviews, countExact, spent) {
  return fail(diagnostics, { knownReviews, countExact, spent });
}
function reviewTransportDiagnostics(transportDiagnostics, incompleteFinal) {
  if (transportDiagnostics.length > 0)
    return transportDiagnostics;
  return incompleteFinal ? [diagnostic("incomplete", "A final review operation is not complete")] : null;
}
function latestReviewSummary(latest, at, records, history, taxonomy, acceptedPolicyRef, knownReviews, spent) {
  if (latest === null)
    return {
      ok: true,
      value: { reviews: 0, reviewId: null, verdict: null, head: null, input: null, at: null, spent: false }
    };
  const decision = records.get(latest.payload.decisionId);
  if (decision?.kind !== "decision")
    return summaryFailure([diagnostic("unknown-reference", `Review ${latest.recordId} lacks its decision`)], knownReviews, true, spent);
  const assessment = validateDecision2(decision, history, taxonomy, acceptedPolicyRef);
  if (assessment.verdict === null)
    return summaryFailure(assessment.diagnostics, knownReviews, true, spent);
  return {
    ok: true,
    value: {
      reviews: knownReviews,
      reviewId: latest.recordId,
      verdict: assessment.verdict,
      head: latest.payload.candidateGitSHA,
      input: latest.payload.input,
      at,
      spent
    }
  };
}
function validateAuthorityReviewSpend(reviews, records, history, taxonomy, acceptedPolicyRef, initialSpent) {
  let spent = initialSpent;
  for (const [index, review] of reviews.entries()) {
    const record = review.record;
    if (record?.kind !== "review")
      continue;
    const decision = records.get(record.payload.decisionId);
    if (decision?.kind !== "decision")
      return {
        diagnostics: [diagnostic("unknown-reference", `Review ${record.recordId} lacks its decision`)],
        spent
      };
    const assessment = validateDecision2(decision, history, taxonomy, acceptedPolicyRef);
    if (!assessment.admissible)
      return { diagnostics: assessment.diagnostics, spent };
    if (index >= 2 && assessment.verdict === "Request changes")
      spent = true;
  }
  return { diagnostics: null, spent };
}
function summarizeAuthorityReviews(history, taxonomy, acceptedPolicyRef) {
  const identity = analyzeReviewIdentity(history, recordMap(history));
  const reviews = identity.reviews;
  const knownReviews = identity.knownReviews;
  const preservedSpent = spentInCompleteHistory(history, taxonomy, acceptedPolicyRef) ?? spentBeforeCurrentPullRequestAttempt(history, taxonomy, acceptedPolicyRef);
  const uncertainSpent = preservedSpent === true ? true : reviews.length >= 3 ? null : false;
  const transportDiagnostics = reviewTransportDiagnostics(identity.transportDiagnostics, identity.incompleteFinal);
  if (transportDiagnostics !== null)
    return summaryFailure(transportDiagnostics, knownReviews, history.source.complete, uncertainSpent);
  const graph = validateRecordGraph(history);
  if (!graph.ok)
    return summaryFailure(graph.diagnostics, knownReviews, history.source.complete, uncertainSpent);
  const records = new Map(graph.value.map((record) => [record.recordId, record]));
  const reviewSpend = validateAuthorityReviewSpend(reviews, records, history, taxonomy, acceptedPolicyRef, preservedSpent === true);
  if (reviewSpend.diagnostics !== null)
    return summaryFailure(reviewSpend.diagnostics, knownReviews, true, reviewSpend.spent);
  if (identity.pendingRoot !== null)
    return summaryFailure([
      diagnostic("incomplete", `Pull-request review inventory ${identity.pendingRoot.recordId} is pending completion by its own final review`, { rootId: identity.pendingRoot.recordId, pendingRoot: true })
    ], knownReviews, true, reviewSpend.spent);
  const at = identity.latestOperation?.parts.map((part) => part.createdAt).find((value) => value !== null) ?? null;
  return latestReviewSummary(identity.latest, at, records, history, taxonomy, acceptedPolicyRef, knownReviews, reviewSpend.spent);
}
function spentReviewFor(reviews, records, history, taxonomy, acceptedPolicyRef) {
  let spentReview = null;
  for (const [index, review] of reviews.entries()) {
    const decision = records.get(review.payload.decisionId);
    if (decision?.kind !== "decision")
      return fail([diagnostic("unknown-reference", `Review ${review.recordId} lacks its decision`)]);
    const assessment = validateDecision2(decision, history, taxonomy, acceptedPolicyRef);
    if (!assessment.admissible)
      return fail(assessment.diagnostics);
    if (index >= 2 && assessment.verdict === "Request changes" && spentReview === null)
      spentReview = review;
  }
  return { ok: true, value: spentReview };
}
function latestApprovingReview(latestReview, summary) {
  return latestReview !== undefined && summary.verdict !== null && summary.verdict !== "Request changes" ? latestReview : null;
}
function redCiRequiresStop(review, reviewCount, facts) {
  return reviewCount > 2 && review !== null && review.payload.candidateGitSHA === facts.candidateGitSHA && facts.ci === "red";
}
function requiredReviewStop(spentReview, latestReview, reviewCount, summary, facts) {
  if (spentReview !== null)
    return {
      reason: "review-bound",
      reviewId: spentReview.recordId,
      detail: { reviews: summary.reviews, verdict: "Request changes" }
    };
  const approved = latestApprovingReview(latestReview, summary);
  if (!redCiRequiresStop(approved, reviewCount, facts))
    return null;
  if (approved === null)
    return null;
  return {
    reason: "ci-failed",
    reviewId: approved.recordId,
    detail: { reviews: summary.reviews, ci: facts.ci }
  };
}
function reviewStateFailure(diagnostics, knownReviews, countExact, spent) {
  return { ok: false, next: "stop", knownReviews, countExact, spent, diagnostics };
}
function nextReviewState(summary, facts) {
  if (summary.head !== null && summary.head !== facts.candidateGitSHA)
    return { ok: true, summary, next: "review", requiredStop: null };
  if (summary.input !== facts.input)
    return { ok: true, summary, next: "review", requiredStop: null };
  if (facts.ci === "pending" || facts.ci === "red")
    return { ok: true, summary, next: "wait", requiredStop: null };
  if (summary.verdict === "Request changes")
    return { ok: true, summary, next: "fix", requiredStop: null };
  return { ok: true, summary, next: summary.verdict === null ? "review" : "admit", requiredStop: null };
}
function deriveReviewState(history, facts, taxonomy) {
  if (!equalScope(history.source.scope, facts))
    return reviewStateFailure([diagnostic("unbound", "Fresh facts have another review scope")], 0, false, null);
  const authorityHistory = classifyHistory(history).authorityHistory;
  const summary = summarizeAuthorityReviews(authorityHistory, taxonomy, facts.acceptedEvidencePolicyRef);
  if (!summary.ok)
    return reviewStateFailure(summary.diagnostics, summary.knownReviews ?? 0, summary.countExact ?? false, summary.spent ?? null);
  const orderedReviews = reviewOperations(authorityHistory).flatMap((operation) => operation.record?.kind === "review" ? [operation.record] : []);
  const records = recordMap(authorityHistory);
  const persistedStop = [...records.values()].find((record) => record.kind === "stop");
  if (persistedStop !== undefined)
    return { ok: true, summary: { ...summary.value, spent: true }, next: "stop", requiredStop: persistedStop.payload };
  const reviewSpend = spentReviewFor(orderedReviews, records, authorityHistory, taxonomy, facts.acceptedEvidencePolicyRef);
  if (!reviewSpend.ok)
    return reviewStateFailure(reviewSpend.diagnostics, summary.value.reviews, true, null);
  const latestReview = orderedReviews.length === 0 ? undefined : orderedReviews[orderedReviews.length - 1];
  const requiredStop = requiredReviewStop(reviewSpend.value, latestReview, orderedReviews.length, summary.value, facts);
  if (requiredStop !== null)
    return { ok: true, summary: { ...summary.value, spent: true }, next: "stop", requiredStop };
  if (facts.ci === "unknown")
    return reviewStateFailure([diagnostic("unreadable", "CI state is unknown and cannot retain an arm")], summary.value.reviews, true, summary.value.spent);
  return nextReviewState(summary.value, facts);
}
// plugins/omp-build/engine/workflow-spec-assessment.ts
function isAssessResult(record) {
  return record.kind === "action-receipt" && record.payload.action === "assess-spec" && record.payload.phase === "result";
}
function specChainFailure(reason, message, code) {
  return { ok: false, reason, evidence: [diagnostic(code ?? reason, message)] };
}

// plugins/omp-build/engine/workflow-spec-authentication-chain.ts
function boundFailure(diagnostics) {
  const code = diagnostics[0]?.code;
  const reason = code === "conflict" || code === "ambiguous" ? "ambiguous" : code === "missing-history" ? "missing-history" : "incomplete";
  return { ok: false, reason, evidence: diagnostics };
}
function mismatchedStart() {
  return specChainFailure("incomplete", "Spec assessment start does not match its result", "unconfirmed");
}
function authenticateStart(confirmed, histories, mandateRef) {
  const startHistory = historyFor(confirmed.payload.start.scope, histories);
  if (startHistory === null)
    return specChainFailure("incomplete", "Spec assessment start is unresolved", "unconfirmed");
  const start = bindExternalRef(confirmed.payload.start, startHistory);
  if (!start.ok)
    return specChainFailure("incomplete", "Spec assessment start is unresolved", "unconfirmed");
  if (start.value.kind !== "action-receipt")
    return mismatchedStart();
  const startPayload = start.value.payload;
  if (startPayload.action !== "assess-spec" || startPayload.phase !== "start")
    return mismatchedStart();
  if (startPayload.actionId !== confirmed.payload.actionId)
    return mismatchedStart();
  if (!sameRef(startPayload.mandate, mandateRef))
    return mismatchedStart();
  if (startPayload.exactInputs.acceptedDigest !== confirmed.payload.exactInputs.acceptedDigest || startPayload.exactInputs.currentDigest !== confirmed.payload.exactInputs.currentDigest || startPayload.exactInputs.acceptedBody !== confirmed.payload.exactInputs.acceptedBody || startPayload.exactInputs.currentBody !== confirmed.payload.exactInputs.currentBody)
    return mismatchedStart();
  return { ok: true };
}
function authenticatedRecord(assessed, histories, mandateRef) {
  const home = historyFor({ repository: assessed.repository, target: assessed.target }, histories);
  if (home === null)
    return specChainFailure("missing-history", "Spec assessment history is missing");
  const bound = bindExternalRef({
    scope: { repository: assessed.repository, target: assessed.target },
    recordId: assessed.recordId,
    kind: assessed.kind
  }, home);
  if (!bound.ok)
    return boundFailure(bound.diagnostics);
  if (!isAssessResult(bound.value))
    return specChainFailure("incomplete", "Spec assessment is not a result");
  const confirmed = bound.value;
  if (confirmed.payload.native.completion !== "completed" || confirmed.payload.native.strict !== "valid")
    return specChainFailure("incomplete", "Spec assessment is not a confirmed native result", "unconfirmed");
  const start = authenticateStart(confirmed, histories, mandateRef);
  if (!start.ok)
    return start;
  return { ok: true, record: confirmed };
}
function authenticatedAssessResult(record, histories, mandateRef) {
  if (!isAssessResult(record))
    return specChainFailure("incomplete", "Spec assessment is not a result");
  const assessed = record;
  if (!sameRef(assessed.payload.mandate, mandateRef))
    return specChainFailure("ambiguous", "Spec assessment names a different mandate");
  return authenticatedRecord(assessed, histories, mandateRef);
}

// plugins/omp-build/engine/workflow-editorial-qualification.ts
function applicableAssessment(record, mandateRef, applied, digest) {
  return record.kind === "action-receipt" && record.payload.action === "assess-spec" && record.payload.phase === "result" && sameRef(record.payload.mandate, mandateRef) && !applied.has(record.recordId) && record.payload.exactInputs.acceptedDigest === digest;
}
function continuousInputs(record, body, digest) {
  const inputs = record.payload.exactInputs;
  return inputs.acceptedBody === body && inputs.acceptedDigest === digest && specDigest(inputs.acceptedBody) === inputs.acceptedDigest && specDigest(inputs.currentBody) === inputs.currentDigest;
}
function qualifyEditorialCandidate(record, input) {
  if (!applicableAssessment(record, input.mandateRef, input.applied, input.digest))
    return { status: "irrelevant" };
  const parsed = specAssessmentSchema.safeParse(record.payload.structured);
  if (!parsed.success)
    return { status: "refused", result: specChainFailure("incomplete", "Applicable spec assessment is malformed") };
  if (parsed.data.classification === "unknown")
    return { status: "refused", result: specChainFailure("ambiguous", "Applicable spec assessment is unknown") };
  if (parsed.data.classification !== "editorial")
    return { status: "material" };
  const authenticated = authenticatedAssessResult(record, input.histories, input.mandateRef);
  if (!authenticated.ok)
    return { status: "refused", result: authenticated };
  if (!continuousInputs(authenticated.record, input.body, input.digest)) {
    return {
      status: "refused",
      result: specChainFailure("material-spec", "Editorial assessment does not continue the accepted spec")
    };
  }
  return { status: "editorial", record: authenticated.record };
}

// plugins/omp-build/engine/workflow-spec-authentication.ts
function receiptRef(record) {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind
  };
}
function sameAssessInputs(left, right) {
  return left.acceptedDigest === right.acceptedDigest && left.currentDigest === right.currentDigest && left.acceptedBody === right.acceptedBody && left.currentBody === right.currentBody;
}
function confirmedAssessPairs(home, histories, mandateRef) {
  for (const record of recordsOf(home)) {
    if (record.kind !== "action-receipt" || record.payload.action !== "assess-spec" || record.payload.phase !== "start")
      continue;
    if (!sameRef(record.payload.mandate, mandateRef))
      continue;
    const startRef = receiptRef(record);
    const results = recordsOf(home).filter((candidate) => candidate.kind === "action-receipt" && candidate.payload.action === "assess-spec" && candidate.payload.phase === "result" && candidate.payload.actionId === record.payload.actionId && sameRef(candidate.payload.start, startRef) && sameRef(candidate.payload.mandate, mandateRef));
    if (results.length === 0)
      return specChainFailure("incomplete", "Spec assessment start has no confirmed result", "action-uncertain");
    if (results.length > 1)
      return specChainFailure("ambiguous", "Spec assessment start has competing results");
    const authenticated = authenticatedAssessResult(results[0] ?? record, histories, mandateRef);
    if (!authenticated.ok)
      return authenticated;
  }
  return { ok: true };
}

// plugins/omp-build/engine/workflow-accepted-spec-chain.ts
function editorialCandidates(home, histories, mandateRef, applied, body, digest) {
  const editorials = [];
  let materialClaims = 0;
  for (const record of recordsOf(home)) {
    const qualified = qualifyEditorialCandidate(record, { histories, mandateRef, applied, body, digest });
    if (qualified.status === "refused")
      return qualified;
    if (qualified.status === "material") {
      materialClaims += 1;
      continue;
    }
    if (qualified.status === "editorial")
      editorials.push(qualified.record);
  }
  return { status: "candidates", editorials, materialClaims };
}
function materialCandidates(home, mandateRef, applied, head, scope) {
  return recordsOf(home).filter((record) => record.kind === "operator-control" && record.payload.control === "accept-material" && sameRef(record.payload.mandate, mandateRef) && !applied.has(record.recordId) && record.payload.predecessor.recordId === head && equalScope(record.payload.predecessor.scope, scope));
}
function bindingFailure(diagnostics) {
  const code = diagnostics[0]?.code;
  const reason = code === "conflict" || code === "ambiguous" ? "ambiguous" : code === "missing-history" ? "missing-history" : "incomplete";
  return { ok: false, reason, evidence: diagnostics };
}
function authenticatedMaterialAssessment(material, histories, mandateRef) {
  const assessmentHistory = historyFor(material.payload.assessment.scope, histories);
  if (assessmentHistory === null) {
    return { status: "refused", result: specChainFailure("missing-history", "Spec assessment history is missing") };
  }
  const assessmentProblem = workflowOperationProblem(assessmentHistory);
  if (assessmentProblem === "ambiguous") {
    return { status: "refused", result: specChainFailure("ambiguous", "Spec assessment history conflicts") };
  }
  if (assessmentProblem === "unconfirmed" || assessmentProblem === "incomplete") {
    return {
      status: "refused",
      result: specChainFailure("incomplete", "Spec assessment history is not confirmed", assessmentProblem)
    };
  }
  const bound = bindExternalRef(material.payload.assessment, assessmentHistory);
  if (!bound.ok)
    return { status: "refused", result: bindingFailure(bound.diagnostics) };
  const authenticated = authenticatedAssessResult(bound.value, histories, mandateRef);
  if (!authenticated.ok)
    return { status: "refused", result: authenticated };
  const parsed = specAssessmentSchema.safeParse(authenticated.record.payload.structured);
  if (!parsed.success) {
    return { status: "refused", result: specChainFailure("incomplete", "Applicable spec assessment is malformed") };
  }
  if (parsed.data.classification === "unknown") {
    return { status: "refused", result: specChainFailure("ambiguous", "Applicable spec assessment is unknown") };
  }
  return { status: "continued", assessment: authenticated.record };
}
function materialMatchesAcceptedSpec(material, assessment, body, digest) {
  const assessed = assessment.payload.exactInputs;
  if (assessed.acceptedBody !== body || assessed.acceptedDigest !== digest) {
    return specChainFailure("material-spec", "Material assessment does not continue the accepted spec");
  }
  if (assessed.currentDigest !== material.payload.specDigest || specDigest(assessed.currentBody) !== material.payload.specDigest) {
    return specChainFailure("material-spec", "Accepted material spec does not match its assessment");
  }
  return null;
}
function nextAcceptedSpecStep(input) {
  const { home, histories, mandateRef, scope, applied, body, digest, head } = input;
  const candidates = editorialCandidates(home, histories, mandateRef, applied, body, digest);
  if (candidates.status === "refused")
    return candidates;
  const materials = materialCandidates(home, mandateRef, applied, head, scope);
  if (candidates.editorials.length > 1)
    return {
      status: "refused",
      result: specChainFailure("ambiguous", "Competing editorial successors continue the same accepted spec")
    };
  if (candidates.editorials.length > 0 && candidates.materialClaims > 0)
    return {
      status: "refused",
      result: specChainFailure("ambiguous", "Editorial and material assessments both continue the accepted spec")
    };
  if (materials.length > 1)
    return {
      status: "refused",
      result: specChainFailure("ambiguous", "Competing material acceptances continue the same accepted spec")
    };
  if (candidates.editorials.length === 1 && materials.length === 1)
    return {
      status: "refused",
      result: specChainFailure("ambiguous", "Editorial and material successors both continue the accepted spec")
    };
  const editorial = candidates.editorials[0];
  if (editorial !== undefined) {
    const inputs = editorial.payload.exactInputs;
    return {
      status: "continued",
      body: inputs.currentBody,
      digest: inputs.currentDigest,
      head: editorial.recordId,
      applied: editorial.recordId,
      chainRef: {
        kind: "editorial",
        recordId: editorial.recordId,
        scope,
        acceptedDigest: inputs.acceptedDigest,
        currentDigest: inputs.currentDigest
      },
      sourceRefs: [receiptRef(editorial)]
    };
  }
  const material = materials[0];
  if (material === undefined)
    return { status: "complete" };
  const continuation = authenticatedMaterialAssessment(material, histories, mandateRef);
  if (continuation.status === "refused")
    return continuation;
  const mismatch = materialMatchesAcceptedSpec(material, continuation.assessment, body, digest);
  if (mismatch !== null)
    return { status: "refused", result: mismatch };
  const assessed = continuation.assessment.payload.exactInputs;
  return {
    status: "continued",
    body: assessed.currentBody,
    digest: assessed.currentDigest,
    head: material.recordId,
    applied: material.recordId,
    chainRef: {
      kind: "accept-material",
      recordId: material.recordId,
      scope,
      specDigest: assessed.currentDigest,
      assessment: material.payload.assessment
    },
    sourceRefs: [receiptRef(material), material.payload.assessment]
  };
}
function resolveAcceptedSpecChain(input) {
  const { confirmed, home, histories, mandateRef, scope } = input;
  const applied = new Set([confirmed.recordId]);
  let body = confirmed.payload.spec.body;
  let digest = confirmed.payload.spec.bodySha256;
  let head = confirmed.recordId;
  const chain = [{ kind: "mandate", recordId: confirmed.recordId, scope, specDigest: digest }];
  const sourceRefs = [mandateRef];
  for (let guard = 0;guard < recordsOf(home).length + 1; guard += 1) {
    const step = nextAcceptedSpecStep({ home, histories, mandateRef, scope, applied, body, digest, head });
    if (step.status === "refused")
      return step.result;
    if (step.status === "complete")
      break;
    body = step.body;
    digest = step.digest;
    head = step.head;
    applied.add(step.applied);
    chain.push(step.chainRef);
    sourceRefs.push(...step.sourceRefs);
  }
  const spec = {
    reference: confirmed.payload.spec.reference,
    body,
    digest,
    lastEditedAt: confirmed.payload.spec.lastEditedAt,
    chain,
    sourceRefs
  };
  return { ok: true, spec };
}

// plugins/omp-build/engine/workflow-accepted-spec.ts
function resolveAcceptedSpec(mandate, histories) {
  const scope = mandateScope(mandate);
  const home = historyFor(scope, histories);
  if (home === null || !home.source.complete)
    return specChainFailure("missing-history", "Mandate history is missing");
  const problem = workflowOperationProblem(home);
  if (problem === "ambiguous")
    return specChainFailure("ambiguous", "Workflow history conflicts");
  if (problem === "unconfirmed" || problem === "incomplete")
    return specChainFailure("incomplete", "Workflow history is not confirmed", problem);
  const mandateRef = { scope, recordId: mandate.recordId, kind: "mandate" };
  const confirmed = confirmedAccountedMandate(home, mandateRef);
  if (confirmed === null)
    return specChainFailure("incomplete", "Mandate is not a confirmed accounted record", "unconfirmed");
  if (JSON.stringify(confirmed) !== JSON.stringify(mandate))
    return specChainFailure("ambiguous", "Mandate does not match the authenticated history");
  if (specDigest(confirmed.payload.spec.body) !== confirmed.payload.spec.bodySha256)
    return specChainFailure("material-spec", "Mandate spec digest does not match its body");
  const pairs = confirmedAssessPairs(home, histories, mandateRef);
  if (!pairs.ok)
    return pairs;
  return resolveAcceptedSpecChain({ confirmed, home, histories, mandateRef, scope });
}
// plugins/omp-build/engine/workflow-plan-macro.ts
function planMacro(evidence, mandate) {
  const empty = emptyMacro(mandate, null);
  if (mandate === null)
    return empty("blocked", [diagnostic("mandate-absent", "plan macro has no mandate")]);
  const accepted = resolveAcceptedSpec(mandate, [
    evidence.issue,
    ...evidence.pullRequest === null ? [] : [evidence.pullRequest],
    ...evidence.parents
  ]);
  if (!accepted.ok)
    return empty("blocked", accepted.evidence);
  const acceptedEmpty = emptyMacro(mandate, accepted.spec.digest);
  const reviewContext = prepareReview(evidence.issue, mandate, accepted.spec.digest, acceptedEmpty);
  if ("macro" in reviewContext)
    return reviewContext.macro;
  return evaluateReview(reviewContext, acceptedEmpty);
}
function emptyMacro(mandate, specDigest) {
  return (phase, evidence, extra = {}) => ({
    phase,
    mandateId: mandate?.recordId ?? null,
    specDigest,
    draftActionId: null,
    reviewActionId: null,
    amendmentActionId: null,
    blockers: [],
    evidence,
    ...extra
  });
}
function prepareReview(history, mandate, acceptedDigest, empty) {
  const starts = receiptsFor(history, "plan", "start");
  const results = planResults(history).filter((record) => planMatchesMandate(record, mandate, acceptedDigest));
  if (starts.some((start) => !planResults(history).some((result) => result.payload.actionId === start.payload.actionId))) {
    return { macro: empty("uncertain", [diagnostic("action-uncertain", "plan start has no result")]) };
  }
  if (receiptsFor(history, "plan-review", "start").some((start) => !planReviews(history).some((result) => result.payload.actionId === start.payload.actionId))) {
    return { macro: empty("uncertain", [diagnostic("action-uncertain", "plan review start has no result")]) };
  }
  const latest = results.filter((record) => record.payload.exactInputs.amendsReviewActionId === null).at(-1);
  if (latest === undefined) {
    return { macro: empty("needs-draft", [diagnostic("needs-draft", "no plan result is bound to the mandate spec")]) };
  }
  const parsedPlan = planOutputSchema.safeParse(latest.payload.structured);
  if (!parsedSuccess(parsedPlan))
    return { macro: empty("blocked", [diagnostic("malformed", "plan result is not a plan")]) };
  const review = matchingReview(history, mandate, latest, planDigest(parsedPlan.data));
  if (review === undefined) {
    return {
      macro: empty("needs-review", [diagnostic("needs-review", "plan has no matching review")], {
        draftActionId: latest.payload.actionId
      })
    };
  }
  return { latest, review, results };
}
function evaluateReview(context, empty) {
  const { latest, review, results } = context;
  const identity = { draftActionId: latest.payload.actionId, reviewActionId: review.payload.actionId };
  const specialists = new Set(review.payload.slots.map((slot) => slot.specialist));
  if (PLAN_REVIEW_SPECIALISTS.some((name) => !specialists.has(name))) {
    return empty("blocked", [diagnostic("missing-contribution", "plan review does not declare both specialists")]);
  }
  const slotStatus = reviewSlotStatus(review);
  if (slotStatus === "invalid") {
    return empty("blocked", [diagnostic("missing-contribution", "plan review contribution is not a review")], identity);
  }
  if (slotStatus === "missing") {
    return empty("blocked", [diagnostic("missing-contribution", "plan review slot has no review")], identity);
  }
  const refs = reviewBlockerRefs(review);
  if (!refs.ok)
    return empty("blocked", refs.evidence, identity);
  if (review.payload.contributions.length > 0 && review.payload.contributions.every((contribution) => {
    const parsed = planReviewSchema.safeParse(contribution.structured);
    return parsed.success && parsed.data.outcome === "clear";
  })) {
    return empty("eligible", [], identity);
  }
  const amendment = results.filter((record) => record.payload.exactInputs.amendsReviewActionId === review.payload.actionId).at(-1);
  if (amendment === undefined) {
    return empty("needs-amendment", [diagnostic("needs-amendment", "blocking review has no amendment")], {
      ...identity,
      blockers: refs.refs
    });
  }
  const parsedAmendment = planOutputSchema.safeParse(amendment.payload.structured);
  if (!parsedSuccess(parsedAmendment)) {
    return empty("blocked", [diagnostic("malformed", "amendment is not a plan")], {
      amendmentActionId: amendment.payload.actionId,
      blockers: refs.refs
    });
  }
  const authored = parsedAmendment.data.resolutions.map((resolution) => resolution.blocker);
  if (!sameBlockerSet(amendment.payload.exactInputs.requiredBlockers, refs.refs) || !sameBlockerSet(authored, refs.refs)) {
    return empty("blocked", [diagnostic("missing-contribution", "amendment resolutions do not cover the review refs")], {
      amendmentActionId: amendment.payload.actionId,
      blockers: refs.refs
    });
  }
  return empty("eligible", [], { ...identity, amendmentActionId: amendment.payload.actionId, blockers: refs.refs });
}
function planResults(history) {
  return receiptsFor(history, "plan", "result").filter((record) => record.payload.action === "plan" && record.payload.phase === "result");
}
function planReviews(history) {
  return receiptsFor(history, "plan-review", "result").filter((record) => record.payload.action === "plan-review" && record.payload.phase === "result");
}
function receiptsFor(history, action, phase) {
  return recordsOf(history).filter((record) => record.kind === "action-receipt" && record.payload.action === action && record.payload.phase === phase);
}
function planMatchesMandate(record, mandate, acceptedDigest) {
  const mandateRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: "mandate" };
  return sameRef(record.payload.mandate, mandateRef) && record.payload.exactInputs.specDigest === acceptedDigest;
}
function matchingReview(history, mandate, latest, digest) {
  return planReviews(history).filter((record) => record.payload.exactInputs.planDigest === digest && record.payload.exactInputs.mandateId === mandate.recordId && record.payload.exactInputs.draftActionId === latest.payload.actionId).at(-1);
}
function reviewSlotStatus(review) {
  const declaredSlots = new Set(review.payload.slots.map((slot) => slot.slotId));
  const coveredSlots = new Set;
  for (const contribution of review.payload.contributions) {
    const parsed = planReviewSchema.safeParse(contribution.structured);
    if (!parsed.success || contribution.host.slotId === null || !declaredSlots.has(contribution.host.slotId))
      return "invalid";
    coveredSlots.add(contribution.host.slotId);
  }
  return [...declaredSlots].some((slotId) => !coveredSlots.has(slotId)) ? "missing" : "valid";
}
function reviewBlockerRefs(review) {
  const refs = [];
  for (const contribution of review.payload.contributions) {
    const parsed = planReviewSchema.safeParse(contribution.structured);
    if (!parsed.success)
      return { ok: false, evidence: [diagnostic("ambiguous", "specialist plan review is not a unique review")] };
    if (parsed.data.outcome !== "blocking")
      continue;
    if (contribution.host.slotId === null)
      return { ok: false, evidence: [diagnostic("malformed", "blocking review has no slot")] };
    for (const blocker of parsed.data.blockers) {
      refs.push({
        sourceId: contribution.host.childId ?? contribution.host.slotId,
        slotId: contribution.host.slotId,
        blockerId: blocker.id
      });
    }
  }
  return { ok: true, refs };
}
function sameBlockerSet(left, right) {
  return left.length === right.length && left.every((item) => right.some((other) => item.sourceId === other.sourceId && item.slotId === other.slotId && item.blockerId === other.blockerId));
}
function parsedSuccess(parsed) {
  return parsed.success;
}

// plugins/omp-build/engine/workflow-action-completion.ts
function actionCompletion(action, evidence, decisions, mandate, facts = null) {
  switch (action) {
    case "plan":
      return planCompletion(evidence, mandate);
    case "implement":
      return implementationCompletion(evidence, mandate);
    case "assess-spec":
      return assessSpecCompletion(evidence, facts, mandate);
    case "attribute-ci":
      return ciAttributionCompletion(evidence, facts, mandate);
    case "publish":
      return selectedCompletion(decisions.publish);
    case "land":
      return selectedCompletion(decisions.landing);
    case "watch":
      return selectedCompletion(decisions.watch);
    default:
      return receiptCompletion(evidence.issue, action);
  }
}
function implementationCompletion(evidence, mandate) {
  const allReceipts = implementationReceipts(evidence.issue);
  const allStarts = allReceipts.filter((record) => record.payload.phase === "start");
  const allResults = allReceipts.filter((record) => record.payload.phase === "result");
  if (allStarts.some((start) => !allResults.some((result) => result.payload.actionId === start.payload.actionId))) {
    return { status: "uncertain", evidence: [diagnostic("action-uncertain", "implement start has no result")] };
  }
  if (allResults.some(isUnadmittedImplementation)) {
    return { status: "blocked", evidence: [diagnostic("unconfirmed", "implement result was not admitted")] };
  }
  const macro = planMacro(evidence, mandate);
  if (macro.phase === "blocked")
    return { status: "blocked", evidence: macro.evidence };
  if (macro.phase === "uncertain")
    return { status: "uncertain", evidence: macro.evidence };
  if (macro.phase !== "eligible" || mandate === null)
    return { status: "not-started", evidence: [] };
  const planActionId = macro.amendmentActionId ?? macro.draftActionId;
  if (planActionId === null)
    return { status: "not-started", evidence: [] };
  const receipts = implementationForPlan(allReceipts, mandate, planActionId);
  const starts = receipts.filter((record) => record.payload.phase === "start");
  const results = receipts.filter((record) => record.payload.phase === "result");
  if (starts.length === 0 && results.length === 0)
    return { status: "not-started", evidence: [] };
  if (results.length > 0)
    return { status: "confirmed", evidence: [] };
  return { status: "blocked", evidence: [diagnostic("unconfirmed", "implement result was not admitted")] };
}
function boundCiAttribution(histories, facts, mandate) {
  const digest = facts.evidenceDigest;
  if (mandate === null || facts.pullRequest === null || facts.candidateGitSHA === null || digest == null || !/^[0-9a-f]{64}$/.test(digest)) {
    return { change: false, refused: false };
  }
  let change = false;
  let refused = false;
  for (const history of histories) {
    for (const record of recordsOf(history)) {
      const attribution = ciAttribution(record, facts, mandate, digest);
      if (attribution === "change")
        change = true;
      if (attribution === "refused")
        refused = true;
    }
  }
  return { change, refused };
}
function planCompletion(evidence, mandate) {
  const macro = planMacro(evidence, mandate);
  if (macro.phase === "eligible")
    return { status: "confirmed", evidence: macro.evidence };
  if (macro.phase === "blocked")
    return { status: "blocked", evidence: macro.evidence };
  if (macro.phase === "uncertain")
    return { status: "uncertain", evidence: macro.evidence };
  return { status: "not-started", evidence: macro.evidence };
}
function selectedCompletion(selector) {
  if (selector.status === "published" || selector.status === "not-applicable") {
    return { status: "confirmed", evidence: selector.evidence };
  }
  if (selector.status === "uncertain")
    return { status: "uncertain", evidence: selector.evidence };
  if (selector.status === "failed")
    return { status: "blocked", evidence: selector.evidence };
  return { status: "not-started", evidence: selector.evidence };
}
function receiptCompletion(history, action) {
  const progress = receiptProgress(history, action);
  if (progress === "uncertain") {
    return { status: "uncertain", evidence: [diagnostic("action-uncertain", `${action} started without a result`)] };
  }
  return { status: progress === "confirmed" ? "confirmed" : "not-started", evidence: [] };
}
function receiptProgress(history, action) {
  const receipts = recordsOf(history).filter((record) => record.kind === "action-receipt" && record.payload.action === action);
  const starts = receipts.filter((record) => record.payload.phase === "start");
  const results = receipts.filter((record) => record.payload.phase === "result");
  if (starts.length === 0 && results.length === 0)
    return "not-started";
  if (starts.some((start) => !results.some((result) => result.payload.actionId === start.payload.actionId)))
    return "uncertain";
  return results.length > 0 ? "confirmed" : "uncertain";
}
function assessSpecCompletion(evidence, facts, mandate) {
  if (facts === null || mandate === null || facts.specBody === null || facts.specDigest === null) {
    return { status: "not-started", evidence: [] };
  }
  if (specDigest(facts.specBody) !== facts.specDigest) {
    return { status: "blocked", evidence: [diagnostic("material-spec", "Live spec digest does not match its body")] };
  }
  const histories = [
    evidence.issue,
    ...evidence.pullRequest === null ? [] : [evidence.pullRequest],
    ...evidence.parents
  ];
  const accepted = resolveAcceptedSpec(mandate, histories);
  if (!accepted.ok)
    return { status: "uncertain", evidence: accepted.evidence };
  const mandateRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: "mandate" };
  const exactInputs = {
    acceptedBody: accepted.spec.body,
    acceptedDigest: accepted.spec.digest,
    currentBody: facts.specBody,
    currentDigest: facts.specDigest
  };
  const receipts = recordsOf(evidence.issue).filter((record) => isMatchingAssessment(record, mandateRef, exactInputs));
  const starts = receipts.filter((record) => record.payload.phase === "start");
  const results = receipts.filter((record) => isAssessResult(record));
  if (starts.length === 0 && results.length === 0)
    return { status: "not-started", evidence: [] };
  if (starts.length !== 1 || results.length !== 1) {
    return {
      status: "uncertain",
      evidence: [diagnostic("unconfirmed", "Current spec assessment is not uniquely paired")]
    };
  }
  const result = results[0];
  if (result === undefined) {
    return { status: "uncertain", evidence: [diagnostic("unconfirmed", "Current spec assessment is missing")] };
  }
  const authenticated = authenticatedAssessResult(result, histories, mandateRef);
  return authenticated.ok ? { status: "confirmed", evidence: [] } : { status: "uncertain", evidence: authenticated.evidence };
}
function isMatchingAssessment(record, mandateRef, exactInputs) {
  return record.kind === "action-receipt" && record.payload.action === "assess-spec" && sameRef(record.payload.mandate, mandateRef) && sameAssessInputs(record.payload.exactInputs, exactInputs);
}
function ciAttributionCompletion(evidence, facts, mandate) {
  const histories = [evidence.issue, ...evidence.pullRequest === null ? [] : [evidence.pullRequest]];
  const receipts = histories.flatMap((history) => recordsOf(history).filter((record) => record.kind === "action-receipt" && record.payload.action === "attribute-ci"));
  const starts = receipts.filter((record) => record.payload.phase === "start");
  const results = receipts.filter((record) => record.payload.phase === "result");
  if (starts.some((start) => !results.some((result) => result.payload.actionId === start.payload.actionId))) {
    return { status: "uncertain", evidence: [diagnostic("action-uncertain", "CI attribution start has no result")] };
  }
  if (facts === null || mandate === null || facts.pullRequest === null || facts.candidateGitSHA === null || facts.evidenceDigest === null) {
    return { status: "not-started", evidence: [] };
  }
  const bound = boundCiAttribution(histories, facts, mandate);
  return bound.change || bound.refused ? { status: "confirmed", evidence: [] } : { status: "not-started", evidence: [] };
}
function implementationReceipts(history) {
  return recordsOf(history).filter((record) => record.kind === "action-receipt" && record.payload.action === "implement");
}
function isUnadmittedImplementation(record) {
  if (record.payload.phase !== "result" || record.payload.admission?.admitted !== true)
    return true;
  const parsed = implementationOutputSchema.safeParse(record.payload.structured);
  return !parsed.success || parsed.data.outcome !== "implemented";
}
function implementationForPlan(receipts, mandate, planActionId) {
  const mandateRef = { scope: mandateScope(mandate), recordId: mandate.recordId, kind: "mandate" };
  return receipts.filter((record) => sameRef(record.payload.mandate, mandateRef) && record.payload.exactInputs.mandateId === mandate.recordId && record.payload.exactInputs.planActionId === planActionId);
}
function ciAttribution(record, facts, mandate, digest) {
  if (record.kind !== "action-receipt" || record.payload.action !== "attribute-ci" || record.payload.phase !== "result")
    return null;
  if (record.payload.mandate.recordId !== mandate.recordId || record.payload.mandate.kind !== "mandate")
    return null;
  if (!equalScope(record.payload.mandate.scope, mandateScope(mandate)))
    return null;
  const inputs = record.payload.exactInputs;
  if (inputs.candidateGitSHA !== facts.candidateGitSHA)
    return null;
  if (facts.pullRequest === null || !equalScope(inputs.scope, facts.pullRequest.scope))
    return null;
  if (inputs.evidenceDigest !== digest || failedCheckEvidenceDigest(inputs) !== digest)
    return null;
  const parsed = ciAttributionSchema.safeParse(record.payload.structured);
  if (!parsed.success)
    return null;
  return parsed.data.attribution === "change" ? "change" : "refused";
}
// plugins/omp-build/engine/workflow-graph.ts
var workflowGraphActionSchema = _enum([
  "frame",
  "assess-spec",
  "plan",
  "implement",
  "publish",
  "review",
  "fix",
  "attribute-ci",
  "land",
  "watch",
  "epic-next",
  "epic-final",
  "mark-fix",
  "hook",
  "report",
  "stop",
  "done"
]);
var workflowConditionSchema = _enum([
  "always",
  "no-mandate",
  "mandate-ready",
  "spec-differs",
  "spec-settled",
  "plan-confirmed",
  "implement-confirmed",
  "pr-open",
  "review-step-review",
  "review-step-fix",
  "review-step-land",
  "review-step-stop",
  "fix-confirmed",
  "ci-red",
  "ci-attributed-change",
  "ci-attribution-refused",
  "merged",
  "end-obligations-met",
  "epic-start",
  "epic-resume",
  "epic-stop",
  "epic-final-review",
  "epic-fix-ticket",
  "epic-post-merge",
  "epic-complete",
  "epic-drop"
]);
var workflowGraphSchema = strictObject({
  version: literal(1),
  productVersion: string2().min(1),
  configVersion: string2().min(1),
  edgeOrder: literal("array"),
  nodes: array(strictObject({ id: string2().min(1), action: workflowGraphActionSchema })).min(1),
  edges: array(strictObject({
    from: string2().min(1),
    to: string2().min(1),
    when: workflowConditionSchema
  })),
  initial: string2().min(1)
});
function validateWorkflowGraph(graph) {
  const parsed = workflowGraphSchema.safeParse(graph);
  if (!parsed.success)
    return fail([
      diagnostic("unsupported-graph", "Workflow graph is not in the closed schema", parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })))
    ]);
  const ids = parsed.data.nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length)
    return fail([diagnostic("unsupported-graph", "Workflow graph repeats a node id")]);
  if (!ids.includes(parsed.data.initial))
    return fail([diagnostic("unsupported-graph", "Workflow graph initial node is missing")]);
  const seenEdges = new Set;
  for (const edge of parsed.data.edges) {
    if (!ids.includes(edge.from) || !ids.includes(edge.to))
      return fail([diagnostic("unsupported-graph", "Workflow graph edge names a missing node")]);
    if (edge.from === edge.to)
      return fail([diagnostic("unsupported-graph", "Workflow graph edge loops on one node")]);
    const key = `${edge.from}\x00${edge.to}\x00${edge.when}`;
    if (seenEdges.has(key))
      return fail([diagnostic("unsupported-graph", "Workflow graph repeats an edge")]);
    seenEdges.add(key);
  }
  return { ok: true, value: parsed.data };
}
function executableGraph(mandate) {
  const effective = mandate.payload.config.effective;
  if (typeof effective !== "object" || effective === null || Array.isArray(effective))
    return fail([diagnostic("unsupported-graph", "Mandate effective config has no graph")]);
  const parsed = validateWorkflowGraph(Reflect.get(effective, "graph"));
  if (!parsed.ok)
    return parsed;
  if (parsed.value.productVersion !== mandate.payload.config.productVersion)
    return fail([diagnostic("config-drift", "Mandate graph product version differs from the mandate")]);
  if (parsed.value.configVersion !== mandate.payload.config.version)
    return fail([diagnostic("config-drift", "Mandate graph config version differs from the mandate")]);
  return parsed;
}

// plugins/omp-build/engine/workflow-parent.ts
function epicListings(mandate, histories) {
  const scope = mandateScope(mandate);
  const refs = [];
  for (const history of histories) {
    for (const record of mandatesOf(history)) {
      if (record.payload.role !== "epic")
        continue;
      if (!record.payload.children.some((child) => equalScope(child.scope, scope)))
        continue;
      refs.push({ scope: mandateScope(record), recordId: record.recordId, kind: "mandate" });
    }
  }
  return refs;
}
function epicParentProblem(mandate, histories) {
  const listings = epicListings(mandate, histories);
  if (listings.length > 1) {
    return { reason: "ambiguous", evidence: [diagnostic("ambiguous", "More than one epic lists this child")] };
  }
  const listing = listings[0];
  if (listing === undefined)
    return null;
  if (mandate.payload.parent === null) {
    return { reason: "missing", evidence: [diagnostic("missing", "Epic-created child omitted its parent")] };
  }
  if (!sameRef(mandate.payload.parent, listing)) {
    return {
      reason: "incompatible",
      evidence: [diagnostic("incompatible", "Epic child parent ref does not name the listing epic")]
    };
  }
  return null;
}

// plugins/omp-build/engine/workflow-mandate-admission.ts
function cycleRefusal(history, seen) {
  const scopeKey = `${history.source.scope.repository}\x00${history.source.scope.target}`;
  return seen.has(scopeKey) ? refused("ambiguous", [diagnostic("ambiguous", "Mandate parent chain cycles")]) : null;
}
function historyRefusal(history) {
  const problem = workflowOperationProblem(history);
  if (problem !== null && mandatesOf(history).length === 0 && problem === "incomplete")
    return refused("incomplete", [diagnostic("incomplete", "History pagination is incomplete")]);
  if (problem === "ambiguous")
    return refused("ambiguous", [diagnostic("ambiguous", "Workflow history conflicts")]);
  if (problem === "unconfirmed")
    return refused("unconfirmed", [diagnostic("unconfirmed", "Workflow history has an incomplete operation")]);
  if (problem === "incomplete")
    return refused("incomplete", [diagnostic("incomplete", "History pagination is incomplete")]);
  return null;
}
function noMandateRefusal(history) {
  const claimed = history.operations.some((operation) => operation.kind === "mandate" || operation.claimedKinds.includes("mandate"));
  return claimed ? refused("unconfirmed", [diagnostic("unconfirmed", "A mandate was claimed but not confirmed")]) : refused("missing", [diagnostic("missing", "No mandate record exists")]);
}
function selectedMandate(history) {
  const mandates = mandatesOf(history);
  if (mandates.length === 0)
    return noMandateRefusal(history);
  const active = mandates.filter((mandate) => !abandoned(history, mandate) && successorOf(history, mandate) === null);
  if (active.length === 0) {
    const last = mandates[mandates.length - 1];
    if (last !== undefined && abandoned(history, last))
      return refused("abandoned", [diagnostic("abandoned", `Mandate ${last.recordId} is abandoned`)]);
    return refused("revoked", [diagnostic("revoked", "The mandate was superseded")]);
  }
  if (active.length > 1)
    return refused("ambiguous", [diagnostic("ambiguous", "More than one mandate is active")]);
  const mandate = active[0];
  if (mandate === undefined)
    return refused("missing", [diagnostic("missing", "No mandate record exists")]);
  if (abandoned(history, mandate))
    return refused("abandoned", [diagnostic("abandoned", `Mandate ${mandate.recordId} is abandoned`)]);
  return mandate;
}
function pauseRefusal(mandate, pause) {
  return {
    status: "refused",
    reason: "paused",
    evidence: [diagnostic("paused", `Mandate ${mandate.recordId} is paused`)],
    pause: {
      mandate: { scope: mandateScope(mandate), recordId: mandate.recordId, kind: "mandate" },
      confirmation: {
        scope: { repository: pause.repository, target: pause.target },
        recordId: pause.recordId,
        kind: "operator-control"
      }
    }
  };
}
function parentPolicyRefusal(mandate, parent, parentHistory, history, externalHistories) {
  if (parent.payload.role === "epic" && !childPermitted(parent, mandateScope(mandate), [parentHistory, history, ...externalHistories]))
    return refused("unknown-binding", [diagnostic("unknown-binding", "Child scope is not approved")]);
  if (mandate.payload.permissions.landing && !parent.payload.permissions.landing)
    return refused("incompatible", [diagnostic("incompatible", "Child landing exceeds the parent")]);
  if (mandate.payload.permissions.correct && !parent.payload.permissions.correct)
    return refused("incompatible", [diagnostic("incompatible", "Child correction exceeds the parent")]);
  if (parent.payload.role !== "epic")
    return null;
  const approved = parent.payload.children.find((child) => equalScope(child.scope, mandateScope(mandate)));
  if (approved !== undefined && mandate.payload.spec.bodySha256 !== approved.specDigest) {
    return refused("materially-changed", [
      diagnostic("materially-changed", "Child spec digest differs from the approved snapshot")
    ]);
  }
  return null;
}
function parentAdmission(mandate, history, externalHistories, seen) {
  if (mandate.payload.parent === null)
    return null;
  const parentHistory = historyFor(mandate.payload.parent.scope, externalHistories);
  if (parentHistory === null)
    return refused("incomplete", [diagnostic("missing-history", "Parent mandate history is missing")]);
  const parent = bindExternalRef(mandate.payload.parent, parentHistory);
  if (!parent.ok)
    return refused("incomplete", parent.diagnostics);
  if (parent.value.kind !== "mandate")
    return refused("unknown-binding", [diagnostic("kind-mismatch", "Parent reference is not a mandate")]);
  const parentSelection = selectApplicableMandate(parentHistory, externalHistories, seen);
  if (parentSelection.status === "refused")
    return parentSelection;
  if (!sameRef({ scope: mandateScope(parentSelection.mandate), recordId: parentSelection.mandate.recordId, kind: "mandate" }, mandate.payload.parent)) {
    return refused("revoked", [diagnostic("revoked", "Child parent reference does not name the active parent mandate")]);
  }
  const policy = parentPolicyRefusal(mandate, parent.value, parentHistory, history, externalHistories);
  return policy;
}
function mandateAdmission(mandate, history, externalHistories, seen) {
  const pause = unliftedPause(history, mandate);
  if (pause !== null)
    return pauseRefusal(mandate, pause);
  const graph = executableGraph(mandate);
  if (!graph.ok)
    return refused("unsupported", graph.diagnostics);
  const omission = epicParentProblem(mandate, [history, ...externalHistories]);
  if (omission !== null)
    return refused(omission.reason, omission.evidence);
  const parent = parentAdmission(mandate, history, externalHistories, seen);
  return parent ?? { status: "applicable", mandate };
}
function selectApplicableMandate(history, externalHistories = [], seen = new Set) {
  const cycle = cycleRefusal(history, seen);
  if (cycle !== null)
    return cycle;
  const historyProblem = historyRefusal(history);
  if (historyProblem !== null)
    return historyProblem;
  const selected = selectedMandate(history);
  if ("status" in selected)
    return selected;
  const nextSeen = new Set(seen);
  nextSeen.add(`${history.source.scope.repository}\x00${history.source.scope.target}`);
  return mandateAdmission(selected, history, externalHistories, nextSeen);
}

// plugins/omp-build/engine/workflow-bound-work-resolution.ts
function configIdentityOf(mandate) {
  const effective = mandate.payload.config.effective;
  const raw = effective !== null && typeof effective === "object" && !Array.isArray(effective) ? Reflect.get(effective, "additionalRequirements") : undefined;
  const additionalRequirements = [];
  if (raw !== undefined) {
    if (!Array.isArray(raw))
      return malformedRequirements();
    for (const item of raw) {
      if (typeof item !== "string" || item.length === 0)
        return malformedRequirements();
      additionalRequirements.push(item);
    }
  }
  return {
    ok: true,
    identity: {
      productVersion: mandate.payload.config.productVersion,
      version: mandate.payload.config.version,
      digest: mandate.payload.config.digest,
      additionalRequirements,
      serialized: JSON.stringify({
        productVersion: mandate.payload.config.productVersion,
        version: mandate.payload.config.version,
        digest: mandate.payload.config.digest,
        additionalRequirements
      })
    }
  };
}
function malformedRequirements() {
  return { ok: false, evidence: [diagnostic("malformed", "Mandate additional requirements are malformed")] };
}
function absentBinding(input) {
  if (input.use !== "landing" && input.explicitSelection)
    return { status: "standalone", binding: "absent" };
  return {
    status: "refused",
    reason: "missing",
    evidence: [diagnostic("mandate-absent", "No workflow binding exists and selection was not explicit")]
  };
}
function applicableBoundWork(input, mandate, permissions, acceptedSpec, configIdentity) {
  const scope = mandateScope(mandate);
  if (input.currentSpec == null)
    return {
      status: "applicable",
      binding: "bound",
      mandate,
      scope,
      permissions,
      acceptedSpec,
      configIdentity,
      drift: null
    };
  if (specDigest(input.currentSpec.body) !== input.currentSpec.digest) {
    return {
      status: "refused",
      reason: "material-spec",
      evidence: [diagnostic("material-spec", "Current spec digest does not match its body")]
    };
  }
  return {
    status: "applicable",
    binding: "bound",
    mandate,
    scope,
    permissions,
    acceptedSpec,
    configIdentity,
    drift: input.currentSpec.digest === acceptedSpec.digest ? "settled" : "differs"
  };
}
function authorizedBoundWork(input, mandate) {
  const pause = outstandingPauseInAuthority(mandate, input.histories);
  if (pause !== null)
    return { status: "refused", reason: "unconfirmed", evidence: [pause] };
  const permissions = {
    landing: mandate.payload.permissions.landing && mandate.payload.role !== "fix-only",
    correct: mandate.payload.permissions.correct
  };
  if (input.use === "landing" && !permissions.landing)
    return { status: "refused", reason: "fix-only", evidence: [diagnostic("fix-only", "Fix-only mandate cannot land")] };
  if (input.use === "correction" && !permissions.correct) {
    return {
      status: "refused",
      reason: "incompatible",
      evidence: [diagnostic("incompatible", "Mandate does not permit correction")]
    };
  }
  const accepted = resolveAcceptedSpec(mandate, input.histories);
  if (!accepted.ok)
    return { status: "refused", reason: accepted.reason, evidence: accepted.evidence };
  const identity = configIdentityOf(mandate);
  if (!identity.ok)
    return { status: "refused", reason: "incomplete", evidence: identity.evidence };
  return applicableBoundWork(input, mandate, permissions, accepted.spec, identity.identity);
}
function resolveBoundWork(input) {
  const binding = selectWorkflowBinding(input);
  if (binding.status === "absent")
    return absentBinding(input);
  if (binding.status !== "bound") {
    return {
      status: "refused",
      reason: binding.status === "incomplete" ? "incomplete" : "ambiguous",
      evidence: binding.diagnostics
    };
  }
  const mandateHistory = historyFor(mandateScope(binding.mandateRecord), input.histories);
  if (mandateHistory === null) {
    return {
      status: "refused",
      reason: "missing-history",
      evidence: [diagnostic("missing-history", "Bound mandate history is missing")]
    };
  }
  const selected = selectApplicableMandate(mandateHistory, input.histories);
  if (selected.status === "refused")
    return { status: "refused", reason: selected.reason, evidence: selected.evidence };
  if (selected.mandate.recordId !== binding.mandateRecord.recordId) {
    return {
      status: "refused",
      reason: "ambiguous",
      evidence: [diagnostic("ambiguous", "Bound mandate is not the active mandate")]
    };
  }
  return authorizedBoundWork(input, selected.mandate);
}
// plugins/omp-build/engine/workflow-chantier.ts
function composeChantier(input) {
  const histories = [input.issue, ...input.pullRequest === null ? [] : [input.pullRequest], ...input.parents];
  for (const history of histories) {
    const problem = workflowOperationProblem(history);
    if (problem !== null)
      return fail([diagnostic(problem, "Workflow history cannot be composed")]);
  }
  return { ok: true, value: { issue: input.issue, pullRequest: input.pullRequest, parents: [...input.parents] } };
}
// plugins/omp-build/engine/workflow-correction-admission.ts
function applicable(mandate) {
  return { status: "applicable", mandate, execution: { correct: true, landing: false } };
}
function ciAttributionUnsafe(history, evidenceDigest) {
  return recordsOf(history).some((record) => {
    if (record.kind !== "action-receipt" || record.payload.action !== "attribute-ci" || record.payload.phase !== "result")
      return false;
    if (evidenceDigest != null && record.payload.exactInputs.evidenceDigest !== evidenceDigest)
      return false;
    const parsed = ciAttributionSchema.safeParse(record.payload.structured);
    return parsed.success && parsed.data.attribution !== "change";
  });
}
function pauseAndCiAuthority(mandate, histories, history, evidenceDigest) {
  const outstandingPause = outstandingPauseInAuthority(mandate, histories);
  if (outstandingPause !== null)
    return refused("unconfirmed", [outstandingPause]);
  if (ciAttributionUnsafe(history, evidenceDigest))
    return refused("unsafe", [diagnostic("unsafe", "CI attribution is not the change")]);
  return null;
}
function correctionAuthority(mandate, histories, history, evidenceDigest) {
  if (!mandate.payload.permissions.correct)
    return refused("incompatible", [diagnostic("incompatible", "Mandate does not permit correction")]);
  return pauseAndCiAuthority(mandate, histories, history, evidenceDigest);
}
function boundPullRequestAdmission(input, histories, selected) {
  const home = historyFor(selected.mandate.scope, histories);
  if (home === null)
    return refused("incomplete", [diagnostic("missing-history", "Bound mandate history is missing")]);
  const applicableMandate = selectApplicableMandate(home, histories.filter((item) => item !== home));
  if (applicableMandate.status === "refused")
    return applicableMandate;
  const refusal = correctionAuthority(applicableMandate.mandate, histories, input.history, input.evidenceDigest);
  return refusal ?? applicable(applicableMandate.mandate);
}
function unboundPullRequestAdmission(input, extra) {
  const local = selectApplicableMandate(input.history, extra);
  if (local.status === "refused")
    return local;
  if (local.mandate.payload.role !== "fix-only" || !equalScope(mandateScope(local.mandate), input.target.scope)) {
    return refused("unknown-binding", [
      diagnostic("unknown-binding", "A pull request without a binding can only correct an explicit fix-only mandate")
    ]);
  }
  const refusal = pauseAndCiAuthority(local.mandate, [input.history, ...extra], input.history, input.evidenceDigest);
  return refusal ?? applicable(local.mandate);
}
function pullRequestAdmission(input, extra) {
  if (input.target.branch === null || input.target.base === null) {
    return refused("unknown-binding", [diagnostic("unknown-binding", "Pull request branch or base was not supplied")]);
  }
  const histories = [input.history, ...input.linkedIssueHistory === null ? [] : [input.linkedIssueHistory], ...extra];
  const selected = selectWorkflowBinding({
    pullRequest: input.target.scope,
    histories,
    native: { branch: input.target.branch, base: input.target.base }
  });
  if (selected.status === "bound")
    return boundPullRequestAdmission(input, histories, selected);
  if (selected.status === "absent")
    return unboundPullRequestAdmission(input, extra);
  return refused(selected.status === "conflicting" ? "ambiguous" : "incomplete", selected.diagnostics);
}
function issueAdmission(input, extra) {
  const histories = input.linkedIssueHistory === null ? extra : [input.linkedIssueHistory, ...extra];
  const selected = selectApplicableMandate(input.history, histories);
  if (selected.status === "refused")
    return selected;
  const mandate = selected.mandate;
  const pause = outstandingPauseInAuthority(mandate, [input.history, ...histories]);
  if (pause !== null)
    return refused("unconfirmed", [pause]);
  if (!equalScope(mandateScope(mandate), input.target.scope) && !input.linkedIssueScopes.some((scope) => equalScope(scope, mandateScope(mandate))))
    return refused("unknown-binding", [diagnostic("unknown-binding", "Mandate scope is not the fix target")]);
  if (!mandate.payload.permissions.correct)
    return refused("incompatible", [diagnostic("incompatible", "Mandate does not permit correction")]);
  if (ciAttributionUnsafe(input.history, input.evidenceDigest))
    return refused("unsafe", [diagnostic("unsafe", "CI attribution is not the change")]);
  return applicable(mandate);
}
function assessFixMandate(input) {
  const extra = input.externalHistories ?? [];
  return input.target.kind === "pull-request" ? pullRequestAdmission(input, extra) : issueAdmission(input, extra);
}
// plugins/omp-build/engine/workflow-correction-mandate.ts
function buildFixOnlyMandate(draft) {
  return buildRecord({
    kind: "mandate",
    version: 1,
    repository: draft.scope.repository,
    target: draft.scope.target,
    recordId: draft.recordId,
    runId: draft.runId,
    operationId: draft.operationId,
    payload: {
      role: "fix-only",
      format: "omp-build-mandate/2",
      branch: draft.branch,
      base: draft.base,
      lineageHead: draft.lineageHead,
      run: null,
      children: null,
      permissions: { landing: false, correct: true },
      config: {
        productVersion: draft.productVersion,
        version: draft.config.version,
        digest: draft.config.digest,
        effective: draft.config.effective
      },
      parent: draft.parent,
      antecedent: draft.antecedent,
      spec: {
        reference: draft.work.reference,
        body: draft.work.body,
        bodySha256: specDigest(draft.work.body),
        lastEditedAt: draft.work.lastEditedAt
      }
    }
  });
}
// plugins/omp-build/engine/workflow-landing-admission.ts
function landingRefusal(reason, evidence) {
  return { ok: false, reason, evidence };
}
function incompleteListedParent(scopes, histories) {
  for (const scope of scopes) {
    const history = historyFor(scope, histories);
    if (history !== null && !history.source.complete)
      return landingRefusal("incomplete", [diagnostic("incomplete", "A listed parent history is incomplete")]);
  }
  return null;
}
function landingBindingReason(selection) {
  if (selection.status === "conflicting")
    return "conflict";
  if (selection.status === "incomplete")
    return "incomplete";
  return "unknown-binding";
}
function landingReason(reason) {
  switch (reason) {
    case "config-invalid":
      return "unsupported";
    case "missing":
    case "paused":
    case "abandoned":
    case "revoked":
    case "unsupported":
    case "ambiguous":
    case "incomplete":
    case "unconfirmed":
    case "unknown-binding":
    case "incompatible":
    case "unsafe":
    case "materially-changed":
    case "missing-history":
      return reason;
  }
}
function selectedCandidate(input) {
  const selected = selectWorkflowBinding({
    pullRequest: input.native.pullRequest,
    histories: input.histories,
    native: { branch: input.native.branch, base: input.native.base }
  });
  if (selected.status === "absent")
    return landingRefusal("missing", [diagnostic("missing", "No workflow binding exists on the pull request")]);
  if (selected.status !== "bound")
    return landingRefusal(landingBindingReason(selected), selected.diagnostics);
  const home = historyFor(mandateScope(selected.mandateRecord), input.histories);
  if (home === null)
    return landingRefusal("missing-history", [diagnostic("missing-history", "Mandate history is missing")]);
  return { mandate: selected.mandateRecord, home };
}
function directAuthority(candidate, input) {
  const { mandate, home } = candidate;
  const omission = epicParentProblem(mandate, input.histories);
  if (omission !== null)
    return landingRefusal(landingReason(omission.reason), omission.evidence);
  if (input.localInhibit !== null && confirmedPause(home, mandate) === null && !abandoned(home, mandate))
    return landingRefusal("unconfirmed", [diagnostic("unconfirmed", "Local inhibit has no confirmed control record")]);
  if (mandate.payload.role === "fix-only" || mandate.payload.permissions.landing === false)
    return landingRefusal("fix-only", [diagnostic("fix-only", "Fix-only mandate cannot land")]);
  if (abandoned(home, mandate))
    return landingRefusal("abandoned", [diagnostic("abandoned", `Mandate ${mandate.recordId} is abandoned`)]);
  if (successorOf(home, mandate) !== null)
    return landingRefusal("revoked", [diagnostic("revoked", `Mandate ${mandate.recordId} was superseded`)]);
  if (unliftedPause(home, mandate) !== null)
    return landingRefusal("paused", [diagnostic("paused", `Mandate ${mandate.recordId} is paused`)]);
  if (mandate.payload.branch === null || mandate.payload.branch !== input.native.branch)
    return landingRefusal("unknown-binding", [diagnostic("unknown-binding", "Mandate branch does not match")]);
  if (mandate.payload.base !== input.native.base)
    return landingRefusal("unknown-binding", [diagnostic("unknown-binding", "Mandate base does not match")]);
  return null;
}
function parentAuthority(candidate, input) {
  const { mandate } = candidate;
  if (mandate.payload.parent === null)
    return null;
  const parentHistory = historyFor(mandate.payload.parent.scope, input.histories);
  if (parentHistory === null)
    return landingRefusal("missing-history", [diagnostic("missing-history", "Parent mandate history is missing")]);
  const parent = bindExternalRef(mandate.payload.parent, parentHistory);
  if (!parent.ok)
    return landingRefusal("incomplete", parent.diagnostics);
  if (parent.value.kind !== "mandate")
    return landingRefusal("unknown-binding", [diagnostic("kind-mismatch", "Parent reference is not a mandate")]);
  const parentSelection = selectApplicableMandate(parentHistory, input.histories);
  if (parentSelection.status === "refused")
    return landingRefusal(landingReason(parentSelection.reason), parentSelection.evidence);
  if (!sameRef({ scope: mandateScope(parentSelection.mandate), recordId: parentSelection.mandate.recordId, kind: "mandate" }, mandate.payload.parent)) {
    return landingRefusal("revoked", [
      diagnostic("revoked", "Child parent reference does not name the active parent mandate")
    ]);
  }
  if (mandate.payload.permissions.landing && !parent.value.payload.permissions.landing)
    return landingRefusal("incompatible", [diagnostic("incompatible", "Child landing exceeds the parent")]);
  return null;
}
function currentAuthority(candidate, input) {
  const { mandate } = candidate;
  const outstandingPause = outstandingPauseInAuthority(mandate, input.histories);
  if (outstandingPause !== null)
    return landingRefusal("unconfirmed", [outstandingPause]);
  if (input.current.supportedConfigVersions.length === 0 || !input.current.supportedConfigVersions.includes(mandate.payload.config.version))
    return landingRefusal("unsupported", [diagnostic("unsupported", "Mandate config version is not supported")]);
  if (mandate.payload.config.productVersion !== input.current.productVersion)
    return landingRefusal("config-drift", [
      diagnostic("config-drift", "Mandate product version differs from the installed package")
    ]);
  if (mandate.payload.config.version !== input.current.configVersion || mandate.payload.config.digest !== input.current.configDigest)
    return landingRefusal("config-drift", [
      diagnostic("config-drift", "Mandate config digest differs from current config")
    ]);
  return null;
}
function acceptedSpecAuthority(candidate, input) {
  if (input.current.specDigest === null || input.current.specBody === null)
    return landingRefusal("material-spec", [diagnostic("material-spec", "Current spec body was not supplied")]);
  if (specDigest(input.current.specBody) !== input.current.specDigest)
    return landingRefusal("material-spec", [diagnostic("material-spec", "Current spec digest does not match its body")]);
  const accepted = resolveAcceptedSpec(candidate.mandate, input.histories);
  if (!accepted.ok)
    return landingRefusal(acceptedReason(accepted.reason), accepted.evidence);
  if (input.current.specDigest !== accepted.spec.digest)
    return landingRefusal("materially-changed", [
      diagnostic("materially-changed", "Live spec differs from the effective approved snapshot")
    ]);
  return null;
}
function acceptedReason(reason) {
  if (reason === "material-spec")
    return "material-spec";
  if (reason === "ambiguous")
    return "ambiguous";
  if (reason === "missing-history")
    return "missing-history";
  return "incomplete";
}
function requireLandingMandate(input) {
  input.native.linkedIssueScopes;
  const listed = incompleteListedParent(input.parentScopes, input.histories);
  if (listed !== null)
    return listed;
  const selected = selectedCandidate(input);
  if ("ok" in selected)
    return selected;
  const direct = directAuthority(selected, input);
  if (direct !== null)
    return direct;
  const parent = parentAuthority(selected, input);
  if (parent !== null)
    return parent;
  const current = currentAuthority(selected, input);
  if (current !== null)
    return current;
  const spec = acceptedSpecAuthority(selected, input);
  if (spec !== null)
    return spec;
  return {
    ok: true,
    recordId: selected.mandate.recordId,
    scope: mandateScope(selected.mandate),
    mandate: selected.mandate
  };
}
// plugins/omp-build/engine/workflow-plan.ts
function bindImplementationCommand(captures, claim) {
  const matches = captures.filter((capture) => capture.toolCallId === claim.toolCallId);
  const selected = matches[0];
  if (matches.length === 0 || selected === undefined)
    return fail([diagnostic("missing", "implementation command was not captured")]);
  if (matches.length > 1)
    return fail([diagnostic("ambiguous", "implementation command id is repeated")]);
  if (selected.command !== claim.command || selected.exitCode !== claim.exitCode || selected.cwd !== claim.cwd) {
    return fail([diagnostic("mismatch", "implementation command text, exit, or cwd does not match the capture")]);
  }
  return {
    ok: true,
    value: {
      toolCallId: selected.toolCallId,
      command: selected.command,
      exitCode: selected.exitCode
    }
  };
}
// plugins/omp-build/engine/workflow-session.ts
function sessionEvidence(facts) {
  const path = facts.preparedWorktree ?? "";
  return [diagnostic("session-cwd", "Session cwd is not the prepared worktree", { path, instruction: `/move ${path}` })];
}
function sessionReady(facts) {
  return facts.sessionCwd !== null && facts.preparedWorktree !== null && facts.sessionCwd === facts.preparedWorktree;
}

// plugins/omp-build/engine/workflow-action-state.ts
function planConfirmed(history, mandate) {
  return planMacro({ issue: history, pullRequest: null, parents: [] }, mandate).phase === "eligible";
}
function implementConfirmed(history, mandate) {
  return implementationCompletion({ issue: history, pullRequest: null, parents: [] }, mandate).status === "confirmed";
}
function prePrStartsAbsent(history) {
  return !recordsOf(history).some((record) => record.kind === "action-receipt" && (record.payload.action === "plan" || record.payload.action === "plan-review" || record.payload.action === "implement"));
}
function adoptedOrConfirmed(history, mandate) {
  return prePrStartsAbsent(history) || implementConfirmed(history, mandate);
}
function workflowBound(mandate, history, pullRequest, facts) {
  if (mandate === null || facts.pullRequest === null || facts.branch === null || pullRequest === null)
    return false;
  const selected = selectWorkflowBinding({
    pullRequest: facts.pullRequest.scope,
    histories: [history, pullRequest],
    native: { branch: facts.branch, base: facts.pullRequest.base }
  });
  return selected.status === "bound" && selected.mandateRecord.recordId === mandate.recordId;
}
function completionBlockReason(completion) {
  const code = completion.evidence[0]?.code;
  if (code === "missing-contribution" || code === "missing-history" || code === "unconfirmed" || code === "action-uncertain")
    return code;
  return "unconfirmed";
}

// plugins/omp-build/engine/workflow-conditions.ts
function unresolvedWork(evidence, facts, decisions, mandate) {
  for (const action of ["plan", "implement", "assess-spec", "attribute-ci", "fix", "review"]) {
    const completion = actionCompletion(action, evidence, decisions, mandate, facts);
    if (completion.status === "uncertain" || completion.status === "blocked")
      return completion;
  }
  return null;
}

// plugins/omp-build/engine/workflow-condition-evaluation.ts
function conditionHolds(when, history, facts, decisions, mandate, pullRequest) {
  switch (when) {
    case "always":
      return true;
    case "no-mandate":
      return mandate === null;
    case "mandate-ready":
      return mandate !== null;
    case "spec-differs":
      return specMatches(false, history, facts, mandate);
    case "spec-settled":
      return specMatches(true, history, facts, mandate);
    case "plan-confirmed":
      return planConfirmed(history, mandate);
    case "implement-confirmed":
      return implementConfirmed(history, mandate);
    case "pr-open":
      return pullRequestIsOpen(history, facts, mandate, pullRequest);
    case "review-step-review":
      return decisions.reviewStep === "review";
    case "review-step-fix":
      return decisions.reviewStep === "fix" && decisions.ciWatchStatus !== "red";
    case "review-step-land":
      return decisions.reviewStep === "land" && workflowBound(mandate, history, pullRequest, facts);
    case "review-step-stop":
      return decisions.reviewStep === "stop";
    case "fix-confirmed":
      return recordsOf(history).some((record) => record.kind === "fix-result");
    case "ci-red":
    case "ci-attributed-change":
    case "ci-attribution-refused":
      return ciConditionHolds(when, history, facts, decisions, mandate, pullRequest);
    case "merged":
      return facts.merged;
    case "end-obligations-met":
      return facts.endObligationsMet;
    case "epic-start":
      return decisions.epicStep === "start";
    case "epic-resume":
      return decisions.epicStep === "resume";
    case "epic-stop":
      return decisions.epicStep === "stop";
    case "epic-final-review":
      return decisions.epicStep === "final-review";
    case "epic-fix-ticket":
      return decisions.epicStep === "fix-ticket";
    case "epic-post-merge":
      return decisions.epicStep === "post-merge";
    case "epic-complete":
      return decisions.epicStep === "complete";
    case "epic-drop":
      return decisions.epicStep === "drop";
    default:
      return null;
  }
}
function specMatches(settled, history, facts, mandate) {
  if (mandate === null || facts.specDigest === null)
    return false;
  const accepted = resolveAcceptedSpec(mandate, [history]);
  if (!accepted.ok)
    return false;
  return settled ? facts.specDigest === accepted.spec.digest : facts.specDigest !== accepted.spec.digest;
}
function pullRequestIsOpen(history, facts, mandate, pullRequest) {
  return facts.pullRequest !== null && workflowBound(mandate, history, pullRequest, facts) && adoptedOrConfirmed(history, mandate);
}
function ciConditionHolds(when, history, facts, decisions, mandate, pullRequest) {
  if (decisions.ciWatchStatus !== "red" || decisions.reviewStep !== "fix")
    return false;
  const bound = boundCiAttribution([history, ...pullRequest === null ? [] : [pullRequest]], facts, mandate);
  if (when === "ci-red")
    return !bound.change && !bound.refused;
  return when === "ci-attributed-change" ? bound.change : bound.refused;
}

// plugins/omp-build/engine/workflow-walk-step.ts
function blocked(reason, evidence) {
  return { status: "blocked", reason, evidence };
}
function pendingAction(node, completion, facts, mandate) {
  if (completion.status !== "not-started" || node.action === "stop" || node.action === "done")
    return null;
  if (WORKTREE_ACTIONS.has(node.action) && !sessionReady(facts))
    return blocked("session-cwd", sessionEvidence(facts));
  return {
    status: "action",
    action: node.action,
    nodeId: node.id,
    mandateId: mandate.recordId,
    evidence: completion.evidence
  };
}
function terminalDecision(node, history, facts, decisions, mandate, pullRequest) {
  if (node.action === "stop" && conditionHolds("ci-attribution-refused", history, facts, decisions, mandate, pullRequest) === true) {
    return {
      status: "terminal",
      reason: "ci-attribution-refused",
      evidence: [diagnostic("ci-attribution-refused", "CI attribution refused correction")]
    };
  }
  if (node.action === "stop" && decisions.reviewStep === "stop")
    return { status: "terminal", reason: "bound-stop", evidence: [diagnostic("bound-stop", "Review bound is spent")] };
  if (node.action !== "done")
    return null;
  return facts.endObligationsMet ? { status: "terminal", reason: "done", evidence: [] } : blocked("unknown-outcome", [diagnostic("unknown-outcome", "Merged work still has end obligations")]);
}
function nextNode(graph, current, node, history, facts, decisions, mandate, pullRequest) {
  const matching = graph.edges.filter((edge) => edge.from === current && conditionHolds(edge.when, history, facts, decisions, mandate, pullRequest) === true);
  const exclusive = [
    ["spec-differs", "spec-settled"],
    ["review-step-review", "review-step-fix", "review-step-land", "review-step-stop"],
    ["ci-red", "ci-attributed-change", "ci-attribution-refused"],
    [
      "epic-start",
      "epic-resume",
      "epic-stop",
      "epic-final-review",
      "epic-fix-ticket",
      "epic-post-merge",
      "epic-complete",
      "epic-drop"
    ]
  ].some((group) => matching.filter((edge) => group.includes(edge.when)).length > 1);
  if (exclusive)
    return blocked("ambiguous-transition", [
      diagnostic("ambiguous-transition", `Node ${current} has exclusive conditions both true`)
    ]);
  const next = matching[0];
  if (next !== undefined)
    return next.to;
  if ((node.action === "land" || node.action === "watch") && mandate.payload.permissions.landing === false)
    return blocked("fix-only", [diagnostic("fix-only", "Fix-only mandate cannot land")]);
  return blocked("unknown-outcome", [diagnostic("unknown-outcome", `Node ${current} has no matching edge`)]);
}
function walkWorkflowStep(graph, nodes, current, evidence, facts, decisions, mandate) {
  const node = nodes.get(current);
  if (node === undefined)
    return blocked("unsupported-graph", [diagnostic("unsupported-graph", "Workflow node is missing")]);
  const completion = actionCompletion(node.action, evidence, decisions, mandate, facts);
  if (completion.status === "uncertain")
    return blocked("action-uncertain", completion.evidence);
  if (completion.status === "blocked")
    return blocked(completionBlockReason(completion), completion.evidence);
  const pending = pendingAction(node, completion, facts, mandate);
  if (pending !== null)
    return pending;
  const terminal = terminalDecision(node, evidence.issue, facts, decisions, mandate, evidence.pullRequest);
  if (terminal !== null)
    return terminal;
  return nextNode(graph, current, node, evidence.issue, facts, decisions, mandate, evidence.pullRequest);
}

// plugins/omp-build/engine/workflow-walk.ts
function blocked2(reason, evidence) {
  return { status: "blocked", reason, evidence };
}
function walkWorkflow(graph, evidence, facts, decisions, mandate) {
  const unresolved = unresolvedWork(evidence, facts, decisions, mandate);
  if (unresolved !== null)
    return blocked2(completionBlockReason(unresolved), unresolved.evidence);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  let current = graph.initial;
  const visited = new Set;
  for (let guard = 0;guard < graph.nodes.length + 1; guard += 1) {
    if (visited.has(current))
      return blocked2("cycle", [diagnostic("cycle", "Workflow traversal repeated a node")]);
    visited.add(current);
    const next = walkWorkflowStep(graph, nodes, current, evidence, facts, decisions, mandate);
    if (typeof next !== "string")
      return next;
    current = next;
  }
  return blocked2("cycle", [diagnostic("cycle", "Workflow traversal did not finish")]);
}

// plugins/omp-build/engine/workflow-reconstruction-admission.ts
function blocked3(reason, evidence) {
  return { status: "blocked", reason, evidence };
}
function historyProblemDecision(history) {
  const problem = workflowOperationProblem(history);
  if (problem === "ambiguous")
    return blocked3("ambiguous-transition", [diagnostic("ambiguous", "Workflow history conflicts")]);
  if (problem === "unconfirmed" || problem === "incomplete")
    return blocked3("incomplete", [diagnostic(problem, "Workflow history is not complete")]);
  return null;
}
function missingMandateDecision(facts) {
  if (!facts.explicitSelection)
    return blocked3("mandate-absent", [diagnostic("mandate-absent", "No mandate exists and selection was not explicit")]);
  if (!sessionReady(facts))
    return blocked3("session-cwd", sessionEvidence(facts));
  return { status: "action", action: "frame", nodeId: null, mandateId: null, evidence: [] };
}
function inactiveMandateDecision(reason, history, facts, evidence) {
  if (facts.explicitSelection)
    return blocked3("successor-required", [
      diagnostic("successor-required", "Explicit selection cannot mint a mandate over a revoked one")
    ]);
  if (reason === "abandoned") {
    return {
      status: "abandoned",
      mandateId: mandatesOf(history).find((record) => abandoned(history, record))?.recordId ?? "unknown",
      evidence
    };
  }
  return blocked3("successor-required", evidence);
}
function pausedMandateDecision(selection, history, facts) {
  const ownPause = equalScope(selection.pause.mandate.scope, history.source.scope);
  if (ownPause && (facts.explicitSelection || facts.explicitResume) && sessionReady(facts)) {
    return {
      status: "action",
      action: "resume",
      nodeId: null,
      mandateId: selection.pause.mandate.recordId,
      evidence: [],
      pause: selection.pause
    };
  }
  return {
    status: "paused",
    mandateId: selection.pause.mandate.recordId,
    confirmed: true,
    evidence: selection.evidence,
    pause: selection.pause
  };
}
function refusalDecision(selection) {
  const code = selection.evidence[0]?.code;
  if (code === "config-drift")
    return blocked3("config-drift", selection.evidence);
  if (code === "unsupported-graph")
    return blocked3("unsupported-graph", selection.evidence);
  if (code === "missing-history" || code === "incomplete")
    return blocked3("missing-history", selection.evidence);
  if (selection.reason === "incompatible" || selection.reason === "unsafe" || selection.reason === "materially-changed")
    return blocked3("unsafe-authority", selection.evidence);
  return blocked3(selection.reason === "unsupported" ? "unsupported-config" : "unconfirmed", selection.evidence);
}
function selectedMandate2(history, externalHistories, facts) {
  const selection = selectApplicableMandate(history, externalHistories);
  if (selection.status === "applicable")
    return { mandate: selection.mandate };
  if (selection.reason === "missing")
    return missingMandateDecision(facts);
  if (selection.reason === "abandoned" || selection.reason === "revoked")
    return inactiveMandateDecision(selection.reason, history, facts, selection.evidence);
  if (selection.reason === "paused")
    return pausedMandateDecision(selection, history, facts);
  return refusalDecision(selection);
}
function localAuthorityDecision(mandate, history, externalHistories, facts) {
  if (facts.localInhibit === "pause" && confirmedPause(history, mandate) === null)
    return blocked3("pause-unconfirmed", [
      diagnostic("pause-unconfirmed", "Pause was inhibited locally but not confirmed")
    ]);
  if (facts.localInhibit === "abandon" && !abandoned(history, mandate))
    return blocked3("unconfirmed", [diagnostic("unconfirmed", "Abandon was inhibited locally but not confirmed")]);
  if (outstandingPauseRequest(history, mandate) !== null)
    return blocked3("pause-unconfirmed", [diagnostic("pause-unconfirmed", "Pause was requested and not confirmed")]);
  const outstandingPause = outstandingPauseInAuthority(mandate, [history, ...externalHistories]);
  if (outstandingPause !== null)
    return blocked3("pause-unconfirmed", [outstandingPause]);
  if (facts.productVersion !== mandate.payload.config.productVersion)
    return blocked3("config-drift", [diagnostic("config-drift", "Host product version differs from the mandate")]);
  if (!facts.supportedConfigVersions.includes(mandate.payload.config.version))
    return blocked3("unsupported-config", [diagnostic("unsupported-config", "Mandate config version is not supported")]);
  if (facts.configDigest !== mandate.payload.config.digest)
    return blocked3("config-drift", [diagnostic("config-drift", "Host config digest differs from the mandate")]);
  return null;
}
function matchingAssessments(history, mandate, facts) {
  if (facts.specDigest === null || facts.specBody === null)
    return [];
  return recordsOf(history).filter((record) => isAssessResult(record) && sameRef(record.payload.mandate, { scope: mandateScope(mandate), recordId: mandate.recordId, kind: "mandate" }) && record.payload.exactInputs.currentDigest === facts.specDigest && record.payload.exactInputs.currentBody === facts.specBody);
}
function assessmentDecision(assessments, mandate, histories) {
  if (assessments.length === 0)
    return null;
  const accepted = resolveAcceptedSpec(mandate, histories);
  if (!accepted.ok)
    return { status: "terminal", reason: "spec-ambiguous", evidence: accepted.evidence };
  const qualified = assessments.filter((assessment) => assessment.payload.exactInputs.acceptedDigest === accepted.spec.digest && assessment.payload.exactInputs.acceptedBody === accepted.spec.body);
  if (qualified.length > 1) {
    return {
      status: "terminal",
      reason: "spec-ambiguous",
      evidence: [diagnostic("spec-ambiguous", "Competing assessments match the active Spec pair")]
    };
  }
  const assessment = qualified[0];
  return assessment === undefined ? null : authenticatedAssessmentDecision(assessment, mandate, histories);
}
function authenticatedAssessmentDecision(assessment, mandate, histories) {
  const authenticated = authenticatedAssessResult(assessment, histories, {
    scope: mandateScope(mandate),
    recordId: mandate.recordId,
    kind: "mandate"
  });
  if (!authenticated.ok)
    return { status: "terminal", reason: "spec-ambiguous", evidence: authenticated.evidence };
  const parsed = specAssessmentSchema.safeParse(authenticated.record.payload.structured);
  if (!parsed.success || parsed.data.classification === "unknown") {
    return {
      status: "terminal",
      reason: "spec-ambiguous",
      evidence: [diagnostic("spec-ambiguous", "Spec classification is unknown")]
    };
  }
  if (parsed.data.classification === "material")
    return blocked3("spec-decision-required", [
      diagnostic("spec-decision-required", "Material spec change has no operator decision")
    ]);
  return null;
}
function bindingDecision(decision, input, history, externalHistories, mandate) {
  if (decision.status !== "action" || decision.action !== "land" && decision.action !== "review" && decision.action !== "watch" || input.facts.pullRequest === null)
    return null;
  if (input.facts.branch === null)
    return blocked3("unknown-binding", [diagnostic("unknown-binding", "Pull request branch was not supplied")]);
  const selected = selectWorkflowBinding({
    pullRequest: input.facts.pullRequest.scope,
    histories: [history, ...externalHistories],
    native: { branch: input.facts.branch, base: input.facts.pullRequest.base }
  });
  if (selected.status === "bound" && selected.mandateRecord.recordId === mandate.recordId)
    return null;
  return blocked3("unknown-binding", selected.status === "bound" ? [diagnostic("unknown-binding", "Workflow binding does not name the active mandate")] : selected.status === "absent" ? [diagnostic("missing", "No workflow binding exists on the pull request")] : selected.diagnostics);
}
function reconstructWorkflow(input) {
  const history = input.evidence.issue;
  const externalHistories = [input.evidence.pullRequest, ...input.evidence.parents].filter((item) => item !== null);
  const historyProblem = historyProblemDecision(history);
  if (historyProblem !== null)
    return historyProblem;
  const selected = selectedMandate2(history, externalHistories, input.facts);
  if (!("mandate" in selected))
    return selected;
  const local = localAuthorityDecision(selected.mandate, history, externalHistories, input.facts);
  if (local !== null)
    return local;
  const histories = [history, ...externalHistories];
  const assessment = assessmentDecision(matchingAssessments(history, selected.mandate, input.facts), selected.mandate, histories);
  if (assessment !== null)
    return assessment;
  const graph = executableGraph(selected.mandate);
  if (!graph.ok)
    return blocked3("unsupported-graph", graph.diagnostics);
  const decision = walkWorkflow(graph.value, input.evidence, input.facts, input.decisions, selected.mandate);
  return bindingDecision(decision, input, history, externalHistories, selected.mandate) ?? decision;
}
// plugins/omp-build/omp/tool-schemas.ts
var ompBuildStartReviewParametersSchema = strictObject({ pr: number2().int().positive().optional() });
function jsonSchema2(schema) {
  return Object.fromEntries(Object.entries(toJSONSchema(schema)));
}
var ompBuildStartReviewParametersJsonSchema = jsonSchema2(ompBuildStartReviewParametersSchema);
// plugins/omp-build/roxabi/workflow-config-digest.ts
import { createHash as createHash2 } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// plugins/omp-build/roxabi/workflow-graph.ts
var WORKFLOW_CONFIG_VERSION = "omp-build-workflow/1";
var NODES = [
  { id: "ready", action: "stop" },
  { id: "frame", action: "frame" },
  { id: "assess-spec", action: "assess-spec" },
  { id: "plan", action: "plan" },
  { id: "implement", action: "implement" },
  { id: "publish", action: "publish" },
  { id: "review", action: "review" },
  { id: "fix", action: "fix" },
  { id: "attribute-ci", action: "attribute-ci" },
  { id: "land", action: "land" },
  { id: "epic-next", action: "epic-next" },
  { id: "epic-final", action: "epic-final" },
  { id: "mark-fix", action: "mark-fix" },
  { id: "hook", action: "hook" },
  { id: "report", action: "report" },
  { id: "stop", action: "stop" },
  { id: "done", action: "done" }
];
var EDGES = [
  { from: "ready", to: "stop", when: "ci-attribution-refused" },
  { from: "ready", to: "stop", when: "epic-stop" },
  { from: "ready", to: "report", when: "epic-drop" },
  { from: "ready", to: "report", when: "epic-complete" },
  { from: "ready", to: "epic-final", when: "epic-final-review" },
  { from: "ready", to: "mark-fix", when: "epic-fix-ticket" },
  { from: "ready", to: "hook", when: "epic-post-merge" },
  { from: "ready", to: "epic-next", when: "epic-start" },
  { from: "ready", to: "epic-next", when: "epic-resume" },
  { from: "ready", to: "attribute-ci", when: "ci-red" },
  { from: "ready", to: "fix", when: "ci-attributed-change" },
  { from: "ready", to: "stop", when: "review-step-stop" },
  { from: "ready", to: "fix", when: "review-step-fix" },
  { from: "ready", to: "land", when: "review-step-land" },
  { from: "ready", to: "review", when: "review-step-review" },
  { from: "ready", to: "done", when: "end-obligations-met" },
  { from: "ready", to: "hook", when: "merged" },
  { from: "ready", to: "review", when: "fix-confirmed" },
  { from: "ready", to: "review", when: "pr-open" },
  { from: "ready", to: "publish", when: "implement-confirmed" },
  { from: "ready", to: "implement", when: "plan-confirmed" },
  { from: "ready", to: "assess-spec", when: "spec-differs" },
  { from: "ready", to: "plan", when: "spec-settled" },
  { from: "ready", to: "plan", when: "mandate-ready" },
  { from: "ready", to: "frame", when: "no-mandate" },
  { from: "ready", to: "stop", when: "always" }
];
var workflowGraphData = { nodes: NODES, edges: EDGES };
function shippedWorkflowGraph(productVersion) {
  if (productVersion.length === 0)
    throw new Error("workflow graph requires the shipped product version");
  return {
    version: 1,
    productVersion,
    configVersion: WORKFLOW_CONFIG_VERSION,
    edgeOrder: "array",
    nodes: NODES.map((node) => ({ ...node })),
    edges: EDGES.map((edge) => ({ ...edge })),
    initial: "ready"
  };
}

// plugins/omp-build/roxabi/workflow-config-digest.ts
function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter((entry) => entry[1] !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function configPinDigest(effective) {
  return createHash2("sha256").update(canonicalJson(effective)).digest("hex");
}
function workflowConfigDigest() {
  return createHash2("sha256").update(canonicalJson({ version: WORKFLOW_CONFIG_VERSION, ...workflowGraphData })).digest("hex");
}
function shippedProductVersion() {
  const start = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(start, "package.json"), join(start, "..", "package.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed.name === "omp-build" && typeof parsed.version === "string" && parsed.version.length > 0)
        return parsed.version;
    } catch {}
  }
  throw new Error("omp-build package.json version is missing");
}
function effectiveWorkflowConfig(productVersion, additionalRequirements) {
  return {
    compatibility: WORKFLOW_CONFIG_VERSION,
    additionalRequirements: [...additionalRequirements],
    graphDigest: workflowConfigDigest(),
    graph: shippedWorkflowGraph(productVersion),
    productVersion
  };
}

// plugins/omp-build/roxabi/workflow-overrides.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
var execFileAsync2 = promisify2(execFile2);
function overrideDiagnostic(code, message) {
  return { code, message };
}
function unreadableOverride(error) {
  return {
    ok: false,
    reason: "unreadable",
    diagnostics: [overrideDiagnostic("unreadable", error instanceof Error ? error.message : String(error))]
  };
}
function unsupportedOverride(message) {
  return { ok: false, reason: "unsupported", diagnostics: [overrideDiagnostic("unsupported", message)] };
}
function isConfigObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}
function parseWorkflowOverride(text) {
  if (text === null)
    return { ok: true, additionalRequirements: [] };
  let parsed;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (error) {
    return unreadableOverride(error);
  }
  if (!isConfigObject(parsed))
    return unsupportedOverride("committed stack.yml is not an object");
  const review = "review" in parsed ? parsed.review : undefined;
  if (review == null)
    return { ok: true, additionalRequirements: [] };
  if (!isConfigObject(review))
    return unsupportedOverride("stack.yml review is not an object");
  if ("graph" in review || "workflow" in review)
    return unsupportedOverride("stack.yml must not carry a project workflow graph");
  const requirements = "additional_requirements" in review ? review.additional_requirements : undefined;
  if (requirements == null)
    return { ok: true, additionalRequirements: [] };
  if (!nonEmptyStringList(requirements))
    return unsupportedOverride("review.additional_requirements must be non-empty strings");
  return { ok: true, additionalRequirements: [...requirements] };
}

// plugins/omp-build/roxabi/workflow-config.ts
var OVERRIDE_PATH = ".dev/stack.yml";
async function readEffectiveFixConfig(input) {
  const shown = await input.git(input.cwd, ["show", `${input.commit}:${OVERRIDE_PATH}`]);
  const missing = shown.code !== 0 && /does not exist|exists on disk, but not in|invalid object/.test(shown.stderr);
  if (shown.code !== 0 && !missing) {
    return {
      ok: false,
      reason: "unreadable",
      diagnostics: [{ code: "unreadable", message: shown.stderr.trim() || "workflow override is unreadable" }]
    };
  }
  const parsed = parseWorkflowOverride(missing ? null : shown.stdout);
  if (!parsed.ok)
    return parsed;
  const effective = effectiveWorkflowConfig(shippedProductVersion(), parsed.additionalRequirements);
  return {
    ok: true,
    version: WORKFLOW_CONFIG_VERSION,
    digest: configPinDigest(effective),
    effective
  };
}

// plugins/omp-build/contracts.ts
function hasNativeUserInterruptFlag(errorId) {
  return is(errorId, Flag.UserInterrupt);
}
export {
  GitHubHistoryReadError,
  KIND_NAMES,
  PLAN_REVIEW_SPECIALISTS,
  PRODUCER_OUTPUTS,
  WORKFLOW_RECORD_KINDS,
  actionCompletion,
  actionReceiptPayloadSchema,
  actionResultSchema,
  applyActionResultSchema,
  assessFixMandate,
  bindExternalRef,
  bindImplementationCommand,
  buildFixOnlyMandate,
  buildRecord,
  causeSchema,
  ciAttributionSchema,
  classifyHistory,
  commandResultSchema,
  composeChantier,
  contributionSchema,
  correctionResultSchema,
  debtReceiptSchema,
  decisionPayloadSchema,
  decisionSchema,
  decodeHistory,
  decodedHistorySchema,
  deriveRecallPlan,
  deriveReviewState,
  diagnosticSchema,
  encodeRecord,
  equalScope,
  externalRecordRefSchema,
  failedCheckEvidenceDigest,
  failedCheckFailureSchema,
  falsificationResultSchema,
  falsifyActionResultSchema,
  finalFindingSchema,
  finalReviewSchema,
  findingReportSchema,
  findingSchema,
  fixRequestSchema,
  fixResultSchema,
  githubScope,
  groupSchema,
  hasNativeUserInterruptFlag,
  historySchema,
  hostEffectAdmissionSchema,
  implementationAdmissionCommandSchema,
  implementationCommandSchema,
  implementationOutputSchema,
  inspectFinding,
  inventorySchema,
  isWorkflowKind,
  jsonSchema,
  kindSchema,
  labelSchema,
  locationSchema,
  mandatePayloadSchema,
  nativeInstant,
  nativeOutcomeSchema,
  nativeProofBashCallSchema,
  observedCommentSchema,
  ompBuildStartReviewParametersJsonSchema,
  ompBuildStartReviewParametersSchema,
  operationAuthoritySchema,
  operationReadSchema,
  operatorControlPayloadSchema,
  originalFindingSchema,
  parseRecord,
  partitionScopedRefs,
  phaseSchema,
  planBlockerRefSchema,
  planDigest,
  planMacro,
  planOutputSchema,
  planResolutionSchema,
  planReviewSchema,
  planReviewSlotSchema,
  planReviewSpecialistSchema,
  planStepSchema,
  policySchema,
  producerJsonSchema,
  projectRecord,
  publishConfirmedWorkflowRecord,
  publishGitHubRecord,
  readComposedWorkflowHistory,
  readEffectiveFixConfig,
  readGitHubHistory,
  readIssueParentAssociation,
  readLandingFacts,
  readLinkedIssueAssociation,
  readNativeIssueFacts,
  readNativePullRequestFacts,
  readScopeIssueBody,
  readWorkflowBinding,
  recallClassSchema,
  recallPlanSchema,
  reconstructWorkflow,
  recordIntegrity,
  recordOperation,
  recordSchema,
  requireLandingMandate,
  resolveAcceptedSpec,
  resolveBoundWork,
  resolveNativeScope,
  resolveNativeTarget,
  reviewInputSnapshotSchema,
  reviewStandardsSchema,
  reviewSubjectSchema,
  scopeSchema,
  scopedRecordRefSchema,
  scopedRefsOf,
  selectApplicableMandate,
  selectWorkflowBinding,
  selectedReviewOperations,
  shippedProductVersion,
  slotSchema,
  specAssessmentSchema,
  specDigest,
  specReportSchema,
  specRowSchema,
  standardsRowSchema,
  stopBotMayAuthor,
  stopSchema,
  submissionSchema,
  summarizeReviews,
  validateDecision2 as validateDecision,
  validateDecisionBindings,
  validateRecordGraph,
  validateRetainedUnusableLabels,
  validateReviewDecisionBindings,
  validateWorkflowGraph,
  verdictSchema,
  workflowBindingPayloadSchema,
  workflowConditionSchema,
  workflowGraphActionSchema,
  workflowGraphSchema,
  workflowReceiptActionSchema
};
