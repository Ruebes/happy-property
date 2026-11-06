// Zuordnung der Appendix-Dateien zur Wohnung (Flora Panorama, 6.11.2026).
// Ausführen: node --experimental-strip-types scripts/verify-appendix.mjs
import { matchAppendix, unitCodes, contentProblem } from '../supabase/functions/reservation-agreement/appendixMatch.ts'

let pass = 0, fail = 0
const T = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`) }
const pdf = 'application/pdf'
const f = (name, mimeType = pdf) => ({ id: name, name, mimeType })
const names = r => r.matched.map(x => x.name)

T('Aarons Dateiname gehört zu B107', names(matchAppendix([f('FLORA_PANORAMA_B107_Appendices.pdf')], 'B107')).join() === 'FLORA_PANORAMA_B107_Appendices.pdf')
T('B107 ist nicht B106', names(matchAppendix([f('FLORA_PANORAMA_B107_Appendices.pdf')], 'B106')).length === 0)
T('B10 trifft nicht B107', names(matchAppendix([f('B107 Appendix.pdf')], 'B10')).length === 0)
T('B107 trifft nicht B1070', names(matchAppendix([f('B1070 Appendix.pdf')], 'B107')).length === 0)
T('Schreibweisen b107, B 107, B-107', ['b107 appendix.pdf', 'B 107 Appendix.pdf', 'Appendix B-107.pdf'].every(n => names(matchAppendix([f(n)], 'B107')).length === 1))
T('Mehrere Wohnungen im Namen: mehrdeutig, nie angehängt', (() => { const r = matchAppendix([f('B107 B106 Appendix.pdf')], 'B107'); return r.matched.length === 0 && r.ambiguous.length === 1 })())
T('Kein PDF: gemeldet, nicht angehängt', (() => { const r = matchAppendix([f('B107 Appendix.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')], 'B107'); return r.matched.length === 0 && r.unsupported.length === 1 })())
T('Google-Dokument zählt', names(matchAppendix([f('B107 Appendix', 'application/vnd.google-apps.document')], 'B107')).length === 1)
T('Mehrere Teile, natürlich sortiert', names(matchAppendix([f('B107 Appendix 10.pdf'), f('B107 Appendix 2.pdf'), f('B107 Appendix 1.pdf')], 'B107')).join('|') === 'B107 Appendix 1.pdf|B107 Appendix 2.pdf|B107 Appendix 10.pdf')
T('Fremde Dateien bleiben draußen', names(matchAppendix([f('Preisliste.pdf'), f('D103 Appendix.pdf'), f('B107 Appendix.pdf')], 'B107')).join() === 'B107 Appendix.pdf')
T('Codes im Text', unitCodes('Apartment B107, Block D103 und C 102').sort().join() === 'B107,C102,D103')
T('Inhalt mit richtiger Wohnung passt', contentProblem('Flora Panorama Apartment B107 Appendix A', 'B107') === null)
T('Inhalt nennt nur eine andere Wohnung: Problem', contentProblem('Apartment B106 Appendix A', 'B107') !== null)
T('Scan ohne Wohnungsnummer bleibt unbeanstandet', contentProblem('Appendix A Specifications', 'B107') === null)
console.log(`\n${pass} bestanden, ${fail} durchgefallen`)
process.exit(fail ? 1 : 0)
