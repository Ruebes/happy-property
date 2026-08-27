import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

// ── Bewertungs-Fragebogen (oeffentlich, token-geschuetzt) ────────────────────
// Kunde bekommt den Link per Lotte-WhatsApp. 5 Fragen (alle optional), dazu
// Sterne + freie Website-Bewertung + optionales Foto. Foto/Bewertung nur mit
// Einwilligung — die der Kunde hier jederzeit wieder entziehen kann.
// Sprache kommt aus leads.language (i18n-Regel: Token-Seiten in Empfaengersprache).

interface ReviewState {
  recipient_name: string; language: string; status: string
  answers: Record<string, string>; rating: number | null
  review_text: string | null; photo_url: string | null; consent: boolean
  recommend: boolean | null; affiliate_url: string | null
}

const QUESTIONS: { key: string; de: string; en: string }[] = [
  { key: 'q1',
    de: 'Wurden in den Zooms und persönlichen Treffen alle Fragen verständlich beantwortet – oder blieb etwas offen?',
    en: 'Were all your questions answered clearly in the Zoom calls and personal meetings – or was anything left open?' },
  { key: 'q2',
    de: 'Waren die von Happy Property vorbereiteten Exposés verständlich und vollständig? Welche Angaben sollten wir noch aufnehmen?',
    en: 'Were the exposés prepared by Happy Property clear and complete? What information should we add?' },
  { key: 'q3',
    de: 'Wurde der Prozess des Kaufes eindeutig erklärt? An welchem Punkt gab es vielleicht Unklarheiten?',
    en: 'Was the purchase process explained clearly? At which point was anything unclear?' },
  { key: 'q4',
    de: 'Hast du dich über den ganzen Prozess immer gut beraten und aufgehoben gefühlt – oder gab es einen Punkt, an dem du dich allein gelassen gefühlt hast?',
    en: 'Did you feel well advised and looked after throughout the whole process – or was there a point where you felt left alone?' },
  { key: 'q5',
    de: 'Gibt es sonst noch Dinge, die Lotte und Sven verbessern können?',
    en: 'Is there anything else Lotte and Sven could improve?' },
]

const T = {
  de: {
    title: 'Deine Meinung zählt',
    intro: 'Danke, dass du dir 2–3 Minuten Zeit nimmst. Alle Felder sind freiwillig – schreib einfach, was dir wichtig ist.',
    reviewHead: 'Deine Bewertung für unsere Website',
    reviewIntro: 'Gern möchten wir deine Erfahrungen mit anderen Menschen teilen und auf unserer Website veröffentlichen. Wir würden uns über 2–3 Sätze freuen – und wenn du magst, auch über ein Bild von dir. Wir veröffentlichen nur den Vornamen. Vielen Dank, Lotte & Sven 🐾',
    reviewPlaceholder: 'Deine Erfahrung mit Happy Property …',
    ratingLabel: 'Deine Gesamtbewertung in Hundesnacks',
    recommendHead: 'Eine letzte Frage',
    recommendQ: 'Würdest du wieder mit Happy Property kaufen – oder Freunden die Zusammenarbeit mit Lotte und Sven empfehlen?',
    recommendYes: 'Ja, klar!',
    recommendNo: 'Eher nicht',
    affiliateHint: 'Super! 🎉 Lotte schickt dir gleich per WhatsApp deinen persönlichen Empfehlungs-Link. Für jede Empfehlung, die zum Kauf führt, bekommst du 1.000 € als Dankeschön.',
    affiliateLink: 'Dein persönlicher Empfehlungs-Link:',
    photoHead: 'Dein Foto (freiwillig)',
    photoIntro: 'Ein Foto von dir macht deine Bewertung persönlicher. Nur mit deiner ausdrücklichen Erlaubnis.',
    photoPick: 'Foto auswählen',
    photoChange: 'Foto ändern',
    consent: 'Ich bin einverstanden, dass Happy Property meine Bewertung und mein Foto auf der Website verwendet. Diese Erlaubnis kann ich jederzeit widerrufen.',
    consentNeeded: 'Für Foto oder Website-Bewertung brauchen wir dein Einverständnis (Häkchen).',
    send: 'Absenden',
    sending: 'Wird gesendet …',
    thanksHead: 'Danke dir! 🧡',
    thanksText: 'Deine Antworten sind bei Lotte und Sven angekommen.',
    edit: 'Antworten bearbeiten',
    revoke: 'Erlaubnis für Website-Nutzung entziehen',
    revokeConfirm: 'Deine Bewertung und dein Foto werden dann nicht (mehr) auf der Website gezeigt. Fortfahren?',
    revoked: 'Erlaubnis entzogen – deine Bewertung und dein Foto werden nicht auf der Website gezeigt.',
    invalid: 'Dieser Link ist leider ungültig.',
    invalidHint: 'Falls der Link neu ist, frag bitte kurz bei Sven oder Lotte nach.',
    error: 'Senden fehlgeschlagen – bitte versuch es gleich noch einmal.',
  },
  en: {
    title: 'Your opinion matters',
    intro: 'Thank you for taking 2–3 minutes. Every field is optional – just write what matters to you.',
    reviewHead: 'Your review for our website',
    reviewIntro: 'We would love to share your experience with others and publish it on our website. A short review of 2–3 sentences would make us very happy – and if you like, add a photo of yourself. We only publish your first name. Thank you, Lotte & Sven 🐾',
    reviewPlaceholder: 'Your experience with Happy Property …',
    ratingLabel: 'Your overall rating in dog treats',
    recommendHead: 'One last question',
    recommendQ: 'Would you buy with Happy Property again – or recommend working with Lotte and Sven to friends?',
    recommendYes: 'Yes, absolutely!',
    recommendNo: 'Rather not',
    affiliateHint: 'Great! 🎉 Lotte will send you your personal referral link via WhatsApp shortly. For every referral that leads to a purchase, you receive 1,000 € as a thank-you.',
    affiliateLink: 'Your personal referral link:',
    photoHead: 'Your photo (optional)',
    photoIntro: 'A photo of you makes your review more personal. Only with your explicit permission.',
    photoPick: 'Choose photo',
    photoChange: 'Change photo',
    consent: 'I agree that Happy Property may use my review and my photo on their website. I can withdraw this permission at any time.',
    consentNeeded: 'For a photo or website review we need your consent (checkbox).',
    send: 'Submit',
    sending: 'Sending …',
    thanksHead: 'Thank you! 🧡',
    thanksText: 'Your answers have reached Lotte and Sven.',
    edit: 'Edit answers',
    revoke: 'Withdraw permission for website use',
    revokeConfirm: 'Your review and photo will then no longer be shown on the website. Continue?',
    revoked: 'Permission withdrawn – your review and photo will not be shown on the website.',
    invalid: 'Sorry, this link is not valid.',
    invalidHint: 'If the link is new, please check with Sven or Lotte.',
    error: 'Sending failed – please try again in a moment.',
  },
}

// Foto clientseitig auf max. 1200px verkleinern → kleine Payload, keine Edge-Timeouts
async function resizeImage(file: File): Promise<{ base64: string; mime: string }> {
  const dataUrl: string = await new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = rej
    r.readAsDataURL(file)
  })
  const img = new Image()
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl })
  const max = 1200
  const scale = Math.min(1, max / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.width * scale)
  canvas.height = Math.round(img.height * scale)
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  const out = canvas.toDataURL('image/jpeg', 0.85)
  return { base64: out.split(',')[1], mime: 'image/jpeg' }
}

export default function Bewertung() {
  const { token } = useParams<{ token: string }>()
  const [state, setState] = useState<ReviewState | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [reviewText, setReviewText] = useState('')
  const [rating, setRating] = useState(0)
  const [consent, setConsent] = useState(false)
  const [photo, setPhoto] = useState<{ base64: string; mime: string; preview: string } | null>(null)
  const [existingPhoto, setExistingPhoto] = useState<string | null>(null)
  const [recommend, setRecommend] = useState<boolean | null>(null)
  const [affiliateUrl, setAffiliateUrl] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)
  const [editing, setEditing] = useState(false)
  const [revoked, setRevoked] = useState(false)
  const [formError, setFormError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase.functions.invoke('review-api', { body: { action: 'view', token } })
      if (error) throw error
      const d = data as { ok?: boolean; error?: string; review?: ReviewState } | null
      if (!d?.ok || !d.review) throw new Error(d?.error || 'invalid')
      setState(d.review)
      setAnswers(d.review.answers ?? {})
      setReviewText(d.review.review_text ?? '')
      setRating(d.review.rating ?? 0)
      setConsent(d.review.consent)
      setExistingPhoto(d.review.photo_url)
      setRecommend(d.review.recommend)
      setAffiliateUrl(d.review.affiliate_url)
      if (d.review.status === 'submitted') setDone(true)
    } catch {
      setErr('invalid')
    } finally { setLoading(false) }
  }, [token])
  useEffect(() => { void load() }, [load])

  const lang: 'de' | 'en' = state?.language === 'en' ? 'en' : 'de'
  const t = T[lang]

  const pickPhoto = async (f: File | null) => {
    if (!f) return
    try {
      const { base64, mime } = await resizeImage(f)
      setPhoto({ base64, mime, preview: `data:${mime};base64,${base64}` })
    } catch { setFormError(t.error) }
  }

  const submit = async () => {
    setFormError('')
    if ((photo || reviewText.trim()) && !consent) { setFormError(t.consentNeeded); return }
    setSending(true)
    try {
      const { data, error } = await supabase.functions.invoke('review-api', { body: {
        action: 'submit', token, answers, rating: rating || undefined,
        review_text: reviewText, consent, recommend,
        ...(photo ? { photo_base64: photo.base64, photo_mime: photo.mime } : {}),
      } })
      if (error) throw error
      const d = data as { ok?: boolean; error?: string; affiliate_url?: string | null } | null
      if (!d?.ok) throw new Error(d?.error)
      if (d.affiliate_url) setAffiliateUrl(d.affiliate_url)
      setDone(true); setEditing(false)
      if (photo) { setExistingPhoto(photo.preview); setPhoto(null) }
    } catch (e) {
      console.error('[Bewertung] submit:', e)
      setFormError(t.error)
    } finally { setSending(false) }
  }

  const revoke = async () => {
    if (!window.confirm(t.revokeConfirm)) return
    try {
      await supabase.functions.invoke('review-api', { body: { action: 'revoke', token } })
      setRevoked(true); setConsent(false)
    } catch { setFormError(t.error) }
  }

  if (loading) {
    return <div className="min-h-screen bg-hp-bg flex items-center justify-center">
      <div className="w-10 h-10 border-4 border-orange-300 border-t-hp-highlight rounded-full animate-spin" />
    </div>
  }
  if (err || !state) {
    return <div className="min-h-screen bg-hp-bg flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm p-8 text-center max-w-md">
        <p className="text-3xl mb-3">🔒</p>
        <p className="text-gray-700 font-medium">{T.de.invalid}</p>
        <p className="text-sm text-gray-400 mt-2">{T.de.invalidHint}</p>
      </div>
    </div>
  }

  const firstName = state.recipient_name.split(' ')[0]

  // ── Danke-Ansicht nach Abgabe ─────────────────────────────────────────────
  if (done && !editing) {
    return <div className="min-h-screen bg-hp-bg font-body py-10 px-4">
      <div className="max-w-xl mx-auto bg-white rounded-2xl shadow-sm p-8 text-center">
        <h1 className="font-heading text-3xl text-hp-slate mb-3">{t.thanksHead}</h1>
        <p className="text-gray-600">{t.thanksText}</p>
        {affiliateUrl && (
          <div className="mt-4 bg-hp-highlight/10 rounded-xl p-4 text-left">
            <p className="text-sm font-medium text-hp-slate mb-1">{t.affiliateLink}</p>
            <p className="text-sm text-hp-highlight break-all">{affiliateUrl}</p>
            <p className="text-xs text-gray-500 mt-2">{t.affiliateHint}</p>
          </div>
        )}
        {revoked && <p className="mt-4 text-sm text-amber-700 bg-amber-50 rounded-lg p-3">{t.revoked}</p>}
        <div className="mt-8 flex flex-col gap-3">
          <button onClick={() => setEditing(true)}
            className="px-5 py-2.5 rounded-xl bg-hp-highlight text-white font-medium hover:opacity-90">
            {t.edit}
          </button>
          {consent && !revoked && (
            <button onClick={() => void revoke()}
              className="px-5 py-2.5 rounded-xl border border-gray-300 text-gray-600 text-sm hover:bg-gray-50">
              {t.revoke}
            </button>
          )}
        </div>
      </div>
    </div>
  }

  // ── Fragebogen ────────────────────────────────────────────────────────────
  return <div className="min-h-screen bg-hp-bg font-body py-10 px-4">
    <div className="max-w-xl mx-auto">
      <div className="text-center mb-8">
        <h1 className="font-heading text-3xl md:text-4xl text-hp-slate">{t.title}</h1>
        <p className="text-gray-500 mt-3">{lang === 'de' ? `Hallo ${firstName}!` : `Hi ${firstName}!`} {t.intro}</p>
      </div>

      <div className="space-y-5">
        {QUESTIONS.map((q, i) => (
          <div key={q.key} className="bg-white rounded-2xl shadow-sm p-5">
            <label className="block text-sm font-medium text-hp-slate mb-2">
              <span className="text-hp-highlight font-semibold mr-1.5">{i + 1}.</span>{q[lang]}
            </label>
            <textarea
              value={answers[q.key] ?? ''}
              onChange={e => setAnswers(a => ({ ...a, [q.key]: e.target.value }))}
              rows={3}
              className="w-full border border-gray-200 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-hp-highlight/40"
            />
          </div>
        ))}

        {/* Website-Bewertung */}
        <div className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="font-heading text-xl text-hp-slate mb-1">{t.reviewHead}</h2>
          <p className="text-sm text-gray-500 mb-3">{t.reviewIntro}</p>
          {/* Hundesnacks statt Sterne — es bewertet ja Lotte 🐾 (Svens Vorgabe) */}
          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            <span className="text-sm text-gray-600 mr-2">{t.ratingLabel}:</span>
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} type="button" onClick={() => setRating(n)}
                className={`text-2xl leading-none transition-transform hover:scale-110 ${n <= rating ? '' : 'grayscale opacity-35'}`}
                aria-label={`${n}/5`}>🦴</button>
            ))}
          </div>
          <textarea
            value={reviewText}
            onChange={e => setReviewText(e.target.value)}
            rows={4} maxLength={2000}
            placeholder={t.reviewPlaceholder}
            className="w-full border border-gray-200 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-hp-highlight/40"
          />
        </div>

        {/* Foto */}
        <div className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="font-heading text-xl text-hp-slate mb-1">{t.photoHead}</h2>
          <p className="text-sm text-gray-500 mb-3">{t.photoIntro}</p>
          <div className="flex items-center gap-4">
            {(photo?.preview || existingPhoto) && (
              <img src={photo?.preview ?? existingPhoto ?? ''} alt=""
                className="w-16 h-16 rounded-full object-cover border border-gray-200" />
            )}
            <button type="button" onClick={() => fileRef.current?.click()}
              className="px-4 py-2 rounded-xl border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">
              {(photo || existingPhoto) ? t.photoChange : t.photoPick}
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={e => void pickPhoto(e.target.files?.[0] ?? null)} />
          </div>
        </div>

        {/* Empfehlung / Affiliate */}
        <div className="bg-white rounded-2xl shadow-sm p-5">
          <h2 className="font-heading text-xl text-hp-slate mb-1">{t.recommendHead}</h2>
          <p className="text-sm text-gray-500 mb-3">{t.recommendQ}</p>
          <div className="flex gap-3">
            <button type="button" onClick={() => setRecommend(true)}
              className={`px-5 py-2.5 rounded-xl text-sm font-medium border ${recommend === true ? 'bg-hp-highlight text-white border-hp-highlight' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
              {t.recommendYes}
            </button>
            <button type="button" onClick={() => setRecommend(false)}
              className={`px-5 py-2.5 rounded-xl text-sm font-medium border ${recommend === false ? 'bg-hp-slate text-white border-hp-slate' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}>
              {t.recommendNo}
            </button>
          </div>
          {recommend === true && <p className="mt-3 text-sm text-gray-600 bg-hp-highlight/10 rounded-xl p-3">{t.affiliateHint}</p>}
        </div>

        {/* Einwilligung */}
        <label className="flex items-start gap-3 bg-white rounded-2xl shadow-sm p-5 cursor-pointer">
          <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-[#ff795d]" />
          <span className="text-sm text-gray-600">{t.consent}</span>
        </label>

        {formError && <p className="text-sm text-red-600 text-center">{formError}</p>}

        <button onClick={() => void submit()} disabled={sending}
          className="w-full py-3.5 rounded-2xl bg-hp-highlight text-white font-semibold text-lg hover:opacity-90 disabled:opacity-50">
          {sending ? t.sending : t.send}
        </button>
      </div>
    </div>
  </div>
}
