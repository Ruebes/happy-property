import{u as y,b as r,j as n}from"./index-DT3V1H9E.js";function v({value:u,onChange:x,options:s,placeholder:h,className:m="",disabled:o=!1,style:g}){const{t:f}=y(),[t,a]=r.useState(!1),i=r.useRef(null),c=r.useRef(null),b=h??f("customSelect.selectPlaceholder","– Auswählen –"),d=s.find(e=>e.value===u);r.useEffect(()=>{if(!t)return;function e(l){i.current&&!i.current.contains(l.target)&&a(!1)}return document.addEventListener("mousedown",e),()=>document.removeEventListener("mousedown",e)},[t]);const p=r.useCallback(e=>{e.key==="Escape"&&t&&(e.stopPropagation(),a(!1))},[t]);return r.useEffect(()=>{if(!t||!c.current)return;const e=c.current.querySelector('[data-selected="true"]');e==null||e.scrollIntoView({block:"nearest"})},[t]),n.jsxs("div",{ref:i,className:`relative ${m}`,onKeyDown:p,children:[n.jsxs("button",{type:"button",disabled:o,onClick:()=>!o&&a(e=>!e),"aria-expanded":t,style:g,className:`
          w-full flex items-center justify-between gap-2
          px-4 py-2.5 rounded-xl border text-sm font-body text-left
          bg-white transition-all duration-150
          ${o?"opacity-50 cursor-not-allowed border-gray-200 text-gray-400":t?"border-[var(--color-highlight)] ring-2 ring-[var(--color-highlight)]/20 text-hp-black":"border-gray-200 hover:border-gray-300 text-hp-black"}
        `,children:[n.jsx("span",{className:`truncate ${d?"":"text-gray-400"}`,children:d?d.label:b}),n.jsx("svg",{className:`w-4 h-4 shrink-0 text-gray-400 transition-transform duration-200
                      ${t?"rotate-180":""}`,viewBox:"0 0 20 20",fill:"currentColor","aria-hidden":"true",children:n.jsx("path",{fillRule:"evenodd",d:`M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0
               111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0
               01.02-1.06z`,clipRule:"evenodd"})})]}),t&&n.jsxs("div",{ref:c,className:`
            absolute z-50 mt-1.5 w-full min-w-[10rem]
            bg-white border border-gray-100 rounded-2xl
            shadow-xl shadow-black/10
            overflow-y-auto max-h-64
            origin-top
            animate-[dropdownOpen_120ms_ease-out_forwards]
          `,style:{animationFillMode:"forwards"},children:[s.length===0&&n.jsx("p",{className:"px-4 py-3 text-sm text-gray-400 font-body",children:f("customSelect.noOptions","Keine Optionen")}),s.map(e=>{const l=e.value===u;return n.jsxs("button",{type:"button","data-selected":l,disabled:e.disabled,onClick:()=>{x(e.value),a(!1)},className:`
                  w-full flex flex-col items-start px-4 py-2.5 text-sm font-body
                  text-left transition-colors duration-100
                  ${e.disabled?"opacity-40 cursor-not-allowed":"cursor-pointer"}
                  ${l?"bg-[var(--color-highlight)]/8 text-[var(--color-highlight)]":"text-hp-black hover:bg-gray-50"}
                `,children:[n.jsx("span",{className:"font-medium leading-snug",children:e.label}),e.hint&&n.jsx("span",{className:"text-xs text-gray-400 mt-0.5 leading-snug",children:e.hint})]},e.value)})]})]})}export{v as C};
