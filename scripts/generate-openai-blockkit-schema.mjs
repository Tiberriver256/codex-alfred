import fs from 'node:fs';

const inputPath = 'schemas/slack-ui-response.schema.json';
const outputPath = 'schemas/blockkit-response.openai.schema.json';

const root = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

fs.writeFileSync(outputPath, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath}`);
