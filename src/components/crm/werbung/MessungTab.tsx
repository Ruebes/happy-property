import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { KontoResponse } from '../../../lib/werbeKonto'
import type { CustomConversionsListResponse } from '../../../lib/werbeWerkzeuge'
import { useWerbeRechte } from './autopilot/useWerbeRechte'
import { useWerbeKontext } from './useWerbeDaten'
import { werkzeugCall } from './zielgruppen/werkzeugeApi'
import ConversionLeadsKarte from './messung/ConversionLeadsKarte'
import CrmEreignisseKarte from './messung/CrmEreignisseKarte'
import DatensatzKarte from './messung/DatensatzKarte'
import EigeneConversionsKarte from './messung/EigeneConversionsKarte'
import KontoKarte from './messung/KontoKarte'
import TestEreignisKarte from './messung/TestEreignisKarte'
import { ladeDiagnose, ladeKonto, ladeMessEinstellungen, nacheinander, type DiagnoseSicht } from './messung/messungApi'
import type { MessEinstellungen } from './messung/typen'
import { useLader } from './messung/useLader'

// ── Reiter „Messung & Konto" des Werbemanagers ───────────────────────────────
// Karten (SPEC3 G2 + H):
//   Datensatz-Gesundheit     Pixel: Empfang, EMQ je Ereignis (pixel_diagnose)
//   Ereignisse aus dem CRM   Conversions API: gesendet/offen/übersprungen/Fehler
//   Conversion-Leads-Stufen  CRM-Stufen für Sofortformular-Leads
//   Eigene Conversions       Liste + Neu anlegen (custom_conversions_*)
//   Test-Ereignis            nur Admin, nur interne Kontakte (werbe-signal test)
//   Konto                    meta-konto: Status, Ausgaben, Ausgabenlimit (nur Admin,
//                            der Server sagt mit darf_limit_aendern, ob es geht)
// Laden: erst nach den Seitendaten, dann streng nacheinander (Micro-Instanz,
// Meta-Konto auf „Limited access"): Einstellungen -> pixel_diagnose (ein Aufruf
// für die ersten drei Karten und den Test) -> eigene Conversions -> Konto.

export default function MessungTab() {
  const { t } = useTranslation()
  const { loading: seiteLaedt } = useWerbeKontext()
  const rechte = useWerbeRechte()

  const [einstellungen, setEinstellungen] = useState<MessEinstellungen | null>(null)
  const gestartet = useRef(false)
  useEffect(() => {
    if (seiteLaedt || gestartet.current) return
    gestartet.current = true
    // refresh: Freischaltung oder Echtzeit-Schalter können sich seit dem letzten Besuch geändert haben
    void nacheinander(() => ladeMessEinstellungen(true)).then(setEinstellungen)
  }, [seiteLaedt])
  const bereit = !seiteLaedt && einstellungen != null

  // Anderer Datensatz: Ref, damit der neue Wert beim nächsten Laden sofort gilt
  const [pixel, setPixel] = useState<string | null>(null)
  const pixelRef = useRef<string | null>(null)
  const echtzeitRef = useRef<boolean | null>(null)
  echtzeitRef.current = einstellungen?.capiEchtzeit ?? null

  const diagnose = useLader<DiagnoseSicht>(() => ladeDiagnose(pixelRef.current, rechte.istAdmin, echtzeitRef.current), bereit)
  // mit_archivierten: die Karte filtert selbst und bietet „Archivierte zeigen" an
  const conversions = useLader<CustomConversionsListResponse>(() => werkzeugCall('custom_conversions_list', { mit_archivierten: true }), bereit)
  const konto = useLader<KontoResponse>(() => ladeKonto(), bereit)

  const neuDiagnose = diagnose.neu
  const leereDiagnose = diagnose.setDaten
  const waehlePixel = useCallback((id: string | null) => {
    pixelRef.current = id
    setPixel(id)
    // Alte Zahlen weg, sonst stehen sie beim Laden oder nach einem Fehler unter dem neuen Datensatz
    leereDiagnose(null)
    void neuDiagnose()
  }, [neuDiagnose, leereDiagnose])

  const keinRecht = !rechte.darfEntscheiden
    ? t('crm.werbung.messung.sperre.keinRecht', 'Dafür fehlt dir das Recht Werbemanager. Ansehen geht, Ändern nicht.')
    : null
  const schreibSperre = keinRecht ?? (einstellungen?.builderEnabled === false
    ? t('crm.werbung.messung.sperre.builder', 'Schreiben bei Meta ist noch gesperrt: Freischaltung durch Sven ausstehend. Prüfen geht schon.')
    : null)

  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <h2 className="font-heading text-xl text-hp-navy">{t('crm.werbung.messung.titel', 'Messung & Konto')}</h2>
        <p className="mt-0.5 text-sm text-gray-600">
          {t('crm.werbung.messung.text', 'Kommen die Signale bei Meta an? Pixel, Ereignisse aus dem CRM, eigene Conversions und das Werbekonto auf einen Blick.')}
        </p>
      </div>

      <nav aria-label={t('crm.werbung.messung.sprung', 'Springe zu')} className="flex flex-wrap gap-1.5">
        {[
          ['messung-datensatz', t('crm.werbung.messung.datensatz.titel', 'Datensatz-Gesundheit')],
          ['messung-crm', t('crm.werbung.messung.crm.titel', 'Ereignisse aus dem CRM')],
          ['messung-stufen', t('crm.werbung.messung.stufen.titel', 'Conversion-Leads-Stufen')],
          ['messung-conversions', t('crm.werbung.messung.conv.titel', 'Eigene Conversions')],
          ['messung-test', t('crm.werbung.messung.test.titel', 'Test-Ereignis')],
          ['messung-konto', t('crm.werbung.messung.konto.titel', 'Konto')],
        ].map(([id, label]) => (
          <button key={id} type="button" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50">{label}</button>
        ))}
      </nav>

      <DatensatzKarte lader={diagnose} pixel={pixel} onPixel={waehlePixel} />
      <div className="grid gap-4 xl:grid-cols-2">
        <CrmEreignisseKarte lader={diagnose} einstellungen={einstellungen} />
        <ConversionLeadsKarte lader={diagnose} einstellungen={einstellungen} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <EigeneConversionsKarte lader={conversions} schreibSperre={schreibSperre} pruefSperre={keinRecht} />
        <TestEreignisKarte lader={diagnose} istAdmin={rechte.istAdmin} />
      </div>
      <KontoKarte lader={konto} />
    </div>
  )
}
