'use strict';

/**
 * Validate and replace req.params / req.query / req.body with the parsed (trimmed,
 * coerced, unknown-keys-stripped) zod result. ZodErrors are turned into 400s by the
 * error middleware.
 *   router.post('/x', validate({ params: idParam, body: schema }), handler)
 */
const validate = (schemas) => (req, res, next) => {
  try {
    for (const part of ['params', 'query', 'body']) {
      if (schemas[part]) req[part] = schemas[part].parse(req[part] ?? {});
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { validate };
