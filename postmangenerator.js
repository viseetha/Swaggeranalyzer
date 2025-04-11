// postman_auto_chainer.js

const fs = require('fs');
const path = require('path');

// Utility to deeply find keys in nested objects
function findPaths(obj, path = '', result = {}) {
  if (typeof obj !== 'object' || obj === null) return;
  for (const key in obj) {
    const newPath = path ? `${path}.${key}` : key;
    result[newPath] = obj[key];
    findPaths(obj[key], newPath, result);
  }
  return result;
}

// Load Postman Collection
function loadCollection(filePath) {
  const data = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(data);
}

// Extract request/response details
function extractDetails(collection) {
  const details = [];

  function walkItems(items, parent = '') {
    for (const item of items) {
      const request = item.request;
      const responses = item.response || [];

      const inputPaths = findPaths(request?.body?.raw ? JSON.parse(request.body.raw) : {});
      const outputPaths = responses.length > 0
        ? findPaths(JSON.parse(responses[0]?.body || '{}'))
        : {};

      details.push({
        name: item.name,
        inputPaths,
        outputPaths,
        item
      });
    }
  }

  walkItems(collection.item);
  return details;
}

// Find possible chains based on key similarity
function findChains(details) {
  const chains = [];
  for (let i = 0; i < details.length; i++) {
    for (let j = 0; j < details.length; j++) {
      if (i === j) continue;
      const outputKeys = Object.keys(details[i].outputPaths);
      const inputKeys = Object.keys(details[j].inputPaths);
      for (const outKey of outputKeys) {
        for (const inKey of inputKeys) {
          if (outKey.toLowerCase().includes(inKey.toLowerCase()) || inKey.toLowerCase().includes(outKey.toLowerCase())) {
            chains.push({
              from: details[i].name,
              to: details[j].name,
              outputKey: outKey,
              inputKey: inKey
            });
          }
        }
      }
    }
  }
  return chains;
}

// Build dependency graph and reorder items
function reorderCollection(details, chains) {
  const graph = new Map();
  details.forEach(d => graph.set(d.name, []));
  chains.forEach(c => graph.get(c.from).push(c.to));

  const visited = new Set();
  const result = [];

  function dfs(node) {
    if (visited.has(node)) return;
    visited.add(node);
    (graph.get(node) || []).forEach(dfs);
    result.push(node);
  }

  details.forEach(d => dfs(d.name));
  return result.reverse();
}

// Add pre-request scripts
function injectPreRequestScripts(details, chains) {
  const variableMap = {};

  chains.forEach(chain => {
    const fromVar = chain.outputKey.replace(/\./g, '_');
    const toVar = chain.inputKey.replace(/\./g, '_');

    // Set variable in test script of from item
    const fromItem = details.find(d => d.name === chain.from).item;
    fromItem.event = fromItem.event || [];
    if (!fromItem.event.some(e => e.listen === 'test')) {
      fromItem.event.push({
        listen: 'test',
        script: {
          exec: [
            `let responseData = pm.response.json();`,
            `pm.variables.set("${fromVar}", responseData.${chain.outputKey});`
          ]
        }
      });
    }

    // Inject variable into to item's pre-request
    const toItem = details.find(d => d.name === chain.to).item;
    toItem.event = toItem.event || [];
    const scriptText = `// Injecting ${toVar} from previous response\n` +
      `let body = JSON.parse(pm.request.body.raw);\n` +
      `body.${chain.inputKey} = pm.variables.get("${fromVar}");\n` +
      `pm.request.body.raw = JSON.stringify(body);`;

    const preEvent = toItem.event.find(e => e.listen === 'prerequest');
    if (preEvent) {
      preEvent.script.exec.push(scriptText);
    } else {
      toItem.event.push({
        listen: 'prerequest',
        script: { exec: [scriptText] }
      });
    }
  });
}

// Save modified collection
function saveCollection(collection, outputPath) {
  fs.writeFileSync(outputPath, JSON.stringify(collection, null, 2));
  console.log(`Updated collection saved to ${outputPath}`);
}

// Main function
function main(inputPath, outputPath) {
  const collection = loadCollection(inputPath);
  const details = extractDetails(collection);
  const chains = findChains(details);
  const orderedNames = reorderCollection(details, chains);

  // Reorder collection items
  collection.item = orderedNames.map(name => details.find(d => d.name === name).item);

  // Inject pre-request mappings
  injectPreRequestScripts(details, chains);

  saveCollection(collection, outputPath);
}

// Run the script
const inputPath = process.argv[2];
const outputPath = process.argv[3] || 'output_collection.json';
if (!inputPath) {
  console.error('Usage: node postman_auto_chainer.js <input_postman.json> [output_postman.json]');
  process.exit(1);
}
main(inputPath, outputPath);
