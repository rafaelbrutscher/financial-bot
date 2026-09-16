import assert from 'node:assert';
import { comandoCategorias, getCategorias, CATEGORIAS_PADRAO } from './src/index.js';

const kv = new Map();
const env = {
  GASTOS_KV: {
    get: async (k, tipo) => (kv.has(k) ? (tipo === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
    put: async (k, v) => void kv.set(k, v),
    delete: async (k) => void kv.delete(k),
  },
};

assert.deepStrictEqual(await getCategorias(env), CATEGORIAS_PADRAO);

await comandoCategorias(env, 'despesa Mercado, Uber , Pets');
assert.deepStrictEqual((await getCategorias(env)).Despesa, ['Mercado', 'Uber', 'Pets']);
assert.deepStrictEqual((await getCategorias(env)).Receita, CATEGORIAS_PADRAO.Receita);

await comandoCategorias(env, 'RECEITA Salário, Freela, Freela');
assert.deepStrictEqual((await getCategorias(env)).Receita, ['Salário', 'Freela']);

const antes = JSON.stringify(await getCategorias(env));
assert.match(await comandoCategorias(env, 'banana x'), /Não entendi/);
const demais = Array.from({ length: 31 }, (_, i) => `c${i}`).join(',');
assert.match(await comandoCategorias(env, `despesa ${demais}`), /Limite/);
assert.match(await comandoCategorias(env, 'despesa ' + 'x'.repeat(41)), /Limite/);
assert.strictEqual(JSON.stringify(await getCategorias(env)), antes);

assert.match(await comandoCategorias(env, ''), /Mercado, Uber, Pets/);
await comandoCategorias(env, 'reset');
assert.deepStrictEqual(await getCategorias(env), CATEGORIAS_PADRAO);

console.log('ok');
