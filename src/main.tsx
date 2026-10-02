import React from 'react'
import ReactDOM from 'react-dom/client'
import { i18nReady } from './lib/i18n'
import './styles/globals.css'
import App from './App'

// Erst rendern, wenn die Startsprache (samt Fallback de) geladen ist, sonst
// blitzen kurz rohe Übersetzungsschlüssel auf. i18nReady erfüllt sich auch,
// wenn der Sprach-Chunk fehlt. Dann startet lazyWithReload (vite:preloadError)
// einmal einen Neuladen, gerendert wird trotzdem sofort, bis der Neuladen
// greift nur mit den Standardtexten aus dem Code (Effekte laufen dabei schon).
const render = () => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
i18nReady.then(render, render)
