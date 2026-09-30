// Does a MoreHands 1.x-style tool definition (TypeBox `parameters` + `execute`) load in 2.2.2?
import { defineTool } from '@flue/runtime/tool';
import { Type } from '@earendil-works/pi-ai';
import * as v from 'valibot';

const attempts = {
  'legacy parameters+execute': () =>
    defineTool({ name: 't', description: 'd', parameters: Type.Object({ fact: Type.String() }), async execute({ fact }) { return fact; } }),
  'input: TypeBox + run': () =>
    defineTool({ name: 't', description: 'd', input: Type.Object({ fact: Type.String() }), run: ({ data }) => data.fact }),
  'input: valibot + run (2.x)': () =>
    defineTool({ name: 't', description: 'd', input: v.object({ fact: v.string() }), run: ({ data }) => data.fact }),
};
for (const [label, fn] of Object.entries(attempts)) {
  try {
    fn();
    console.log(`OK     ${label}`);
  } catch (e) {
    console.log(`THROWS ${label}: ${e.message}`);
  }
}
