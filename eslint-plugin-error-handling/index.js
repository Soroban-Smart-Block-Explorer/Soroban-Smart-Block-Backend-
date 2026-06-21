module.exports = {
  rules: {
    'require-async-handler': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Require async Express handlers to be wrapped in asyncHandler or have a top-level try/catch',
          category: 'Possible Errors',
          recommended: true,
        },
        fixable: 'code',
        schema: [], // no options
        messages: {
          missingAsyncHandler: 'Async route handlers must be wrapped in asyncHandler to prevent unhandled promise rejections.',
        },
      },
      create: function(context) {
        return {
          CallExpression(node) {
            // Check if it's a router call like router.get, app.post, etc.
            if (node.callee.type !== 'MemberExpression') return;
            const propertyName = node.callee.property.name;
            const isRouterMethod = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'].includes(propertyName);
            if (!isRouterMethod) return;

            // Look at the arguments passed to the router method
            const args = node.arguments;
            for (const arg of args) {
              // If the argument is an async function or arrow function
              if ((arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') && arg.async) {
                // If it's a bare async function, check if it has a try/catch wrapping the whole body
                const body = arg.body;
                let hasTopLevelTryCatch = false;
                if (body.type === 'BlockStatement' && body.body.length > 0) {
                  // If there's exactly one statement and it's a TryStatement, or if it has a TryStatement wrapping the main logic.
                  // For strictness, let's just demand asyncHandler.
                  // But if we want to allow top-level try/catch:
                  const tryStmts = body.body.filter(stmt => stmt.type === 'TryStatement');
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
                        fixer.insertTextAfter(arg, ')')
                      ];
                    }
                  });
                }
              }
            }
          }
        };
      }
    }
  }
};
