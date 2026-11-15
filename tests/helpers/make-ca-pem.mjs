import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const der = readFileSync(join(here, '..', 'fixtures', 'test-ca.cer'));
const body = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
const pem = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
writeFileSync(join(here, '..', 'fixtures', 'test-ca.pem'), pem, 'utf8');
console.log('pem bytes', statSync(join(here, '..', 'fixtures', 'test-ca.pem')).size);
