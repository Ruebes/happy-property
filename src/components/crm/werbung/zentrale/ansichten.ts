import type { EigeneKennzahl } from './spalten'
import type { StatusKategorie } from './status'

// ── Gespeicherte Ansichten und eigene Kennzahlen (nur in diesem Browser) ─────
// localStorage kann fehlen oder werfen (privates Fenster, gesperrte Daten):
// jeder Zugriff in try/catch, die Zentrale funktioniert auch ohne.

export type ZentraleEbene = 'baum' | 'campaign' | 'adset' | 'ad'
export type StatusFilter = 'alle' | StatusKategorie

export interface Sortierung { key: string; ab: boolean }

export interface Ansicht {
  id: string
  name: string
  preset: string
  spalten: string[]
  ebene: ZentraleEbene
  status: StatusFilter
  nurMitAusgaben: boolean
  suche: string
  sort: Sortierung | null
}

const KEY_ANSICHTEN = 'hp.werbung.zentrale.ansichten.v1'
const KEY_KENNZAHLEN = 'hp.werbung.zentrale.kennzahlen.v1'
const KEY_ZULETZT = 'hp.werbung.zentrale.zuletzt.v1'

function lesen<T>(key: string, pruefe: (v: unknown) => v is T, ersatz: T): T {
  try {
    const roh = window.localStorage.getItem(key)
    if (!roh) return ersatz
    const v: unknown = JSON.parse(roh)
    return pruefe(v) ? v : ersatz
  } catch {
    return ersatz
  }
}

function schreiben(key: string, wert: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(wert))
    return true
  } catch {
    return false
  }
}

const istObjekt = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const istAnsicht = (v: unknown): v is Ansicht =>
  istObjekt(v) && typeof v.id === 'string' && typeof v.name === 'string' && Array.isArray(v.spalten)
  && typeof v.preset === 'string' && typeof v.ebene === 'string'

const istKennzahl = (v: unknown): v is EigeneKennzahl =>
  istObjekt(v) && typeof v.id === 'string' && typeof v.name === 'string' && typeof v.formel === 'string'
  && (v.format === 'zahl' || v.format === 'eur' || v.format === 'prozent')

export const ladeAnsichten = (): Ansicht[] =>
  lesen(KEY_ANSICHTEN, (v): v is Ansicht[] => Array.isArray(v), [] as Ansicht[]).filter(istAnsicht).slice(0, 30)

export const speichereAnsichten = (liste: Ansicht[]): boolean => schreiben(KEY_ANSICHTEN, liste.slice(0, 30))

export const ladeKennzahlen = (): EigeneKennzahl[] =>
  lesen(KEY_KENNZAHLEN, (v): v is EigeneKennzahl[] => Array.isArray(v), [] as EigeneKennzahl[]).filter(istKennzahl).slice(0, 20)

export const speichereKennzahlen = (liste: EigeneKennzahl[]): boolean => schreiben(KEY_KENNZAHLEN, liste.slice(0, 20))

/** Zuletzt benutzte Ansicht (ohne Namen), damit die Zentrale so wieder aufgeht */
export const ladeZuletzt = (): Ansicht | null => lesen(KEY_ZULETZT, (v): v is Ansicht | null => v === null || istAnsicht(v), null)
export const speichereZuletzt = (a: Ansicht): void => { schreiben(KEY_ZULETZT, a) }

export const neueId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
