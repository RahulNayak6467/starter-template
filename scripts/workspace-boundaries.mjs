import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const contains = (directory, filename) => {
  const path = relative(directory, filename);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const literalValue = (node) => {
  if (typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return undefined;
};

export const createWorkspaceBoundaryRule = (workspaces) => ({
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      relativeWorkspace:
        'Import other workspaces by package name, not by relative or absolute path.',
      appImport: 'Apps must not import other apps. Move shared code into a package.',
      packageImportApp: 'Packages must not import apps. Move shared code into a package.',
      undeclaredDependency:
        'Declare "{{name}}" in this workspace package.json before importing it.',
    },
  },
  create(context) {
    const filename = context.filename;
    const owner = workspaces.find((workspace) => contains(workspace.directory, filename));
    if (!owner) return {};

    const check = (node) => {
      const specifier = literalValue(node);
      if (specifier === undefined) return;

      const byPath = specifier.startsWith('.') || isAbsolute(specifier);
      const destination = byPath ? resolve(dirname(filename), specifier) : undefined;
      const target = workspaces.find((workspace) =>
        byPath
          ? contains(workspace.directory, destination)
          : specifier === workspace.name || specifier.startsWith(`${workspace.name}/`),
      );
      if (!target || target === owner) return;

      if (target.kind === 'app') {
        context.report({
          node,
          messageId: owner.kind === 'app' ? 'appImport' : 'packageImportApp',
        });
      } else if (byPath) {
        context.report({ node, messageId: 'relativeWorkspace' });
      } else if (!Object.hasOwn(owner.dependencies, target.name)) {
        context.report({ node, messageId: 'undeclaredDependency', data: { name: target.name } });
      }
    };

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node.source);
      },
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      CallExpression: (node) => {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments[0]
        ) {
          check(node.arguments[0]);
        }
      },
    };
  },
});
