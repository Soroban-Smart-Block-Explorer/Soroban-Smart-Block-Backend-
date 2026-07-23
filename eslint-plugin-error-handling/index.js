'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Lazy-load the Prisma schema fields once per ESLint run
// ---------------------------------------------------------------------------
let _prismaFields = null;

function getPrismaFields() {
  if (_prismaFields) return _prismaFields;

  const schemaPath = path.resolve(process.cwd(), 'prisma/schema.prisma');
  if (!fs.existsSync(schemaPath)) {
    _prismaFields = new Map();
    return _prismaFields;
  }

  const content = fs.readFileSync(schemaPath, 'utf-8');
  const models = new Map();
  const modelRe = /^model\s+(\w+)\s*\{([^}]+)\}/gm;
  let m;

  while ((m = modelRe.exec(content)) !== null) {
    const modelName = m[1];
    const body = m[2];
    const fields = new Set();

    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;
      const fieldMatch = trimmed.match(/^(\w+)\s+[\w.]+/);
      if (fieldMatch) fields.add(fieldMatch[1]);
    }

    models.set(modelName, fields);
  }

  _prismaFields = models;
  return _prismaFields;
}

// Common variable name → model name heuristics used in this codebase
const VAR_MODEL_HINTS = {
  tx: 'Transaction',
  transaction: 'Transaction',
  event: 'Event',
  ledger: 'Ledger',
  contract: 'Contract',
  wallet: 'SmartWallet',
};

module.exports = {
  rules: {
    // ── existing rule ────────────────────────────────────────────────────────
    'require-async-handler': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Require async Express handlers to be wrapped in asyncHandler or have a top-level try/catch',
          category: 'Possible Errors',
          recommended: true,
        },
        fixable: 'code',
        schema: [],
        messages: {
          missingAsyncHandler:
            'Async route handlers must be wrapped in asyncHandler to prevent unhandled promise rejections.',
        },
      },
      create: function (context) {
        return {
          CallExpression(node) {
            if (node.callee.type !== 'MemberExpression') return;
            const propertyName = node.callee.property.name;
            const isRouterMethod = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'].includes(
              propertyName,
            );
            if (!isRouterMethod) return;

            const args = node.arguments;
            for (const arg of args) {
              if (
                (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') &&
                arg.async
              ) {
                const body = arg.body;
                let hasTopLevelTryCatch = false;
                if (body.type === 'BlockStatement' && body.body.length > 0) {
                  const tryStmts = body.body.filter((stmt) => stmt.type === 'TryStatement');
                  if (tryStmts.length === 1 && body.body.length === 1) {
                    hasTopLevelTryCatch = true;
                  }
                }

                if (!hasTopLevelTryCatch) {
                  context.report({
                    node: arg,
                    messageId: 'missingAsyncHandler',
                    fix(fixer) {
                      return [
                        fixer.insertTextBefore(arg, 'asyncHandler('),
                        fixer.insertTextAfter(arg, ')'),
                      ];
                    },
                  });
                }
              }
            }
          },
        };
      },
    },

    // ── new rule: no-phantom-prisma-field ────────────────────────────────────
    'no-phantom-prisma-field': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow property accesses on Prisma model variables that reference fields not present in the schema.',
          category: 'Possible Errors',
          recommended: true,
        },
        schema: [
          {
            type: 'object',
            properties: {
              // Allow callers to supply extra variable→model hints
              extraHints: {
                type: 'object',
                additionalProperties: { type: 'string' },
              },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          phantomField:
            "'{{field}}' does not exist on Prisma model '{{model}}'. " +
            "Check the schema or use the correct field name.",
        },
      },
      create(context) {
        const options = context.options[0] || {};
        const hints = Object.assign({}, VAR_MODEL_HINTS, options.extraHints || {});
        const prismaModels = getPrismaFields();

        // Track which param names inside .map((varName) => ...) correspond to
        // which model, inferred from the call chain: prisma.transaction.findMany
        // We track via scope analysis on the call expression.
        const varModelMap = new Map();

        return {
          // prisma.transaction.findMany({ ... }).then(txs => ...)
          // Build a mapping for the current scope based on call expressions.
          CallExpression(node) {
            // Match prisma.<model>.<method>
            if (
              node.callee.type === 'MemberExpression' &&
              node.callee.object &&
              node.callee.object.type === 'MemberExpression' &&
              node.callee.object.object &&
              node.callee.object.object.name === 'prisma'
            ) {
              const modelRaw = node.callee.object.property.name;
              const modelName = modelRaw
                ? modelRaw.charAt(0).toUpperCase() + modelRaw.slice(1)
                : null;
              if (!modelName || !prismaModels.has(modelName)) return;

              // Walk up to find the variable it's assigned to
              const parent = node.parent;
              if (
                parent &&
                parent.type === 'VariableDeclarator' &&
                parent.id &&
                parent.id.type === 'Identifier'
              ) {
                varModelMap.set(parent.id.name, modelName);
              }
              // Destructuring: const [txs, count] = await Promise.all([...
              if (
                parent &&
                parent.type === 'ArrayExpression' &&
                parent.parent &&
                parent.parent.type === 'AwaitExpression' &&
                parent.parent.parent &&
                parent.parent.parent.type === 'VariableDeclarator' &&
                parent.parent.parent.id &&
                parent.parent.parent.id.type === 'ArrayPattern'
              ) {
                const elements = parent.parent.parent.id.elements;
                const idx = parent.elements ? parent.elements.indexOf(node) : -1;
                if (idx >= 0 && elements[idx] && elements[idx].type === 'Identifier') {
                  varModelMap.set(elements[idx].name, modelName);
                }
              }
            }
          },

          // Check <varName>.<field> accesses
          MemberExpression(node) {
            if (
              node.object.type !== 'Identifier' ||
              node.property.type !== 'Identifier' ||
              node.computed
            )
              return;

            const varName = node.object.name;
            const fieldName = node.property.name;

            // Look up model: prefer dynamic map, then static hints
            const modelName = varModelMap.get(varName) || hints[varName];
            if (!modelName) return;

            const fields = prismaModels.get(modelName);
            if (!fields) return;

            if (!fields.has(fieldName)) {
              context.report({
                node: node.property,
                messageId: 'phantomField',
                data: { field: fieldName, model: modelName },
              });
            }
          },
        };
      },
    },
  },
};
