import React from 'react'
import ReactDOM from 'react-dom/client'
import { i18nReady } from './lib/i18n'
import './styles/globals.css'
import App from './App'

// Erst rendern, wenn die Startsprache (samt Fallback de) geladen ist, sonst
// blitzen kurz rohe Übersetzungsschlüssel auf. Fehlt der Sprach-Chunk, lädt
// lazyWithReload die Seite einmal neu; scheitert es danach erneut, wird
// trotzdem gerendert (dann nur mit den Standardtexten aus dem Code).
const render = () => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}
i18nReady.then(render, render)
