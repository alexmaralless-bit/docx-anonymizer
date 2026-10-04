// Минимальный валидатор JSON Schema (подмножество draft 2020-12, достаточное для schemas/*.json) — без зависимостей.
// Поддержано: type (в т.ч. массивом), enum, const, pattern, minLength, minimum, maximum, minItems, uniqueItems,
// required, properties, additionalProperties:false, items, oneOf, $ref (#/$defs/… и внешние по $id-имени файла).

/** @param {Record<string, object>} [registry] имя файла/ссылка → схема, для внешних $ref */
export function createValidator(registry = {}) {
  const typeOk = (t, v) =>
    t === 'null'
      ? v === null
      : t === 'array'
        ? Array.isArray(v)
        : t === 'integer'
          ? Number.isInteger(v)
          : t === 'object'
            ? v !== null && typeof v === 'object' && !Array.isArray(v)
            : typeof v === t;

  function resolve(ref, root) {
    const [file, frag = ''] = ref.split('#');
    const base = file ? registry[file] : root;
    if (!base) throw new Error(`Неизвестная схема: ${ref}`);
    return {
      schema: frag
        ? frag
            .split('/')
            .filter(Boolean)
            .reduce((o, k) => o[k], base)
        : base,
      root: base,
    };
  }

  /** @returns {string[]} ошибки вида «/путь: сообщение» (пусто = валидно) */
  function validate(schema, value, root = schema, path = '') {
    const errs = [];
    const fail = (m) => errs.push(`${path || '/'}: ${m}`);
    if (schema.$ref) {
      const r = resolve(schema.$ref, root);
      return validate(r.schema, value, r.root, path);
    }
    if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) fail(`ожидалось ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) fail(`значение вне enum: ${JSON.stringify(value)}`);
    if (schema.type) {
      const types = [].concat(schema.type);
      if (!types.some((t) => typeOk(t, value))) {
        fail(`тип ${typeof value}, ожидалось ${types.join('|')}`);
        return errs;
      }
    }
    if (typeof value === 'string') {
      if (schema.minLength != null && value.length < schema.minLength) fail('слишком короткая строка');
      if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) fail(`не соответствует ${schema.pattern}`);
    }
    if (typeof value === 'number') {
      if (schema.minimum != null && value < schema.minimum) fail(`меньше ${schema.minimum}`);
      if (schema.maximum != null && value > schema.maximum) fail(`больше ${schema.maximum}`);
    }
    if (Array.isArray(value)) {
      if (schema.minItems != null && value.length < schema.minItems) fail(`меньше ${schema.minItems} элементов`);
      if (schema.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) fail('элементы не уникальны');
      if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, root, `${path}/${i}`)));
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of schema.required || []) if (value[k] === undefined) fail(`нет поля ${k}`);
      for (const [k, s] of Object.entries(schema.properties || {}))
        if (k in value && value[k] !== undefined) errs.push(...validate(s, value[k], root, `${path}/${k}`));
      if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!(k in (schema.properties || {}))) fail(`лишнее поле ${k}`);
    }
    if (schema.oneOf) {
      const ok = schema.oneOf.filter((s) => validate(s, value, root, path).length === 0).length;
      if (ok !== 1) fail(`oneOf: подошло ${ok} вариантов`);
    }
    return errs;
  }
  return { validate };
}
