// Design 3.12: no color literal outside src/theme/tokens.ts, so every theme stays one edit away.
const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Reject color literals outside src/theme/tokens.ts' },
    messages: { literal: 'Color literal "{{text}}": use a token from src/theme/tokens.ts.' },
    schema: [],
  },
  create(context) {
    const report = (node, text) => {
      const m = COLOR.exec(text);
      if (m) context.report({ node, messageId: 'literal', data: { text: m[0] } });
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') report(node, node.value);
      },
      TemplateElement(node) {
        report(node, node.value.raw);
      },
    };
  },
};
