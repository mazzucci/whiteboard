// The brief: Claude's bottom line and a few one-line sections, beside the
// diagrams, in the pane where the conversation is (Brief / Chat). The server
// sends the whole brief with each change; this page shows what changed. A
// section is picked with a click: it lights up the boxes it is about on the
// diagram, and goes with the next message, so a question lands under it.
'use strict'

/** The brief as the server last sent it, or null. */
let briefNow = null
/** The section picked for the next message, by id. */
let briefPick = null
/** Each section's version the person has seen: a newer line shows what it replaced until then. */
const briefSeen = new Map()
/** The pane the person chose, kept through a reconnect: Brief unless they went to Chat. */
let paneChosen = 'brief'
/** The person's choices on constraints (or answers to Claude's suggestions), by section: they go with the next message. */
const briefChoices = new Map()

const briefPane = $('brief')

/** Claude started or finished a turn: the brief says so, and a question still without an answer says where to look. */
function briefTurnChanged(text) {
  const status = $('brief-status')
  status.hidden = !text
  $('brief-status-text').textContent = text ?? ''
  if (briefNow?.sections.some(s => s.asks?.some(a => a.question && !a.answer))) renderBrief()
}

/** A reconnect replays the brief from its first card: start from nothing. */
function resetBrief() {
  briefNow = null
  briefPick = null
  briefSeen.clear()
  briefPane.innerHTML = ''
  document.body.classList.remove('has-brief')
  showPane('chat')
  showBriefPick()
  showFocus()
}

/** The Brief / Chat switch, beside the board. */
function showPane(pane) {
  document.body.classList.toggle('pane-brief', pane === 'brief' && !!briefNow)
  document.querySelectorAll('.panes [data-pane]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.pane === (document.body.classList.contains('pane-brief') ? 'brief' : 'chat'))))
  if (pane === 'chat') {
    $('chat-unread').hidden = true
    $('chat-unread').textContent = ''
    const messages = $('messages')
    messages.scrollTop = messages.scrollHeight
  }
}
document.querySelectorAll('.panes [data-pane]').forEach(
  b =>
    (b.onclick = () => {
      paneChosen = b.dataset.pane
      showPane(b.dataset.pane)
    }),
)

/** A message from Claude while the brief is in front: counted on the Chat switch. */
function countChatUnread() {
  if (!document.body.classList.contains('pane-brief')) return
  const badge = $('chat-unread')
  badge.textContent = String(Number(badge.textContent || 0) + 1)
  badge.hidden = false
}

/** What changed, in words, for the conversation's history (a question is in it already). */
function briefChangeLine(change, by) {
  const s = briefNow.sections.find(x => x.id === change.id) ?? briefNow.dropped.find(x => x.id === change.id)
  const name = s ? `“${s.title}”` : ''
  const who = by === 'you' ? 'You' : 'Claude'
  const chosen = s?.choices?.find(c => c.id === s.chosen)?.label
  return {
    new: briefNow.mode === 'decide' ? 'Claude started a decision' : 'Claude wrote a brief',
    bottomLine: briefNow.mode === 'decide' && briefNow.isProposal ? 'Claude wrote the proposal' : 'Claude changed the bottom line',
    reject: `You turned down ${name}`,
    mode: briefNow.mode === 'decide' ? 'Claude turned the brief into a decision' : 'Claude turned the decision back into a brief',
    add: s?.suggested ? `Claude suggests ${name}` : s?.by === 'you' ? `Claude added your idea ${name}` : `Claude added ${name}`,
    update: change.isNewLine ? `Claude rewrote ${name}` : `Claude updated ${name}`,
    drop: by === 'you' ? `You turned down ${name}` : `Claude dropped ${name}${s?.why ? `: ${s.why}` : ''}`,
    restore: `Claude brought back ${name}`,
    answer: `Claude answered under ${name}`,
    settle: `${who} settled ${name}${chosen ? `: ${chosen}` : ''}`,
    reopen: `Claude opened ${name} again`,
    accept: `You took Claude's suggestion ${name}`,
  }[change.op] ?? ''
}

/** Whether a choice can still be made on a section: taking or turning down a suggestion, one of a constraint's choices, or confirming or turning down an assumption. */
function isChoiceValid(s, choice) {
  if (!s) return false
  if (s.suggested) return choice === 'accept' || choice === 'decline' || !!s.choices?.some(c => c.id === choice)
  if (s.kind !== 'constraint' || s.status === 'settled') return false
  if (s.choices?.length) return s.choices.some(c => c.id === choice)
  return s.status === 'assumed' && (choice === '' || choice === 'reject')
}

/** The constraints still open (an assumption does not hold up the proposal; Claude's suggestions wait for the person). */
const briefOpen = () => (briefNow?.sections ?? []).filter(s => s.kind === 'constraint' && s.status === 'open' && !s.suggested)

/** A brief from the server: shown, with what changed marked, and said in the conversation. */
function briefArrived(card, isReplay) {
  // Taken off again (its diagram failed to draw), back to the brief before it, or none.
  if (!card.brief) {
    resetBrief()
    briefEvent('The brief was taken off with its diagram', null)
    return
  }
  const isFirst = !briefNow
  briefNow = card.brief
  document.body.classList.add('has-brief')
  // A new brief starts with nothing seen.
  if (card.changes.some(c => c.op === 'new')) briefSeen.clear()
  if (isReplay) for (const s of briefNow.sections) briefSeen.set(s.id, s.v)
  if (isReplay) briefSeen.set('bottom line', briefNow.v)
  if (briefPick && !briefNow.sections.some(s => s.id === briefPick)) {
    briefPick = null
    showBriefPick()
  }
  // A choice still has to make sense as the brief now is: on a section that is there, still to settle, and one of its options.
  for (const [id, choice] of [...briefChoices]) {
    if (!isChoiceValid(briefNow.sections.find(x => x.id === id), choice)) briefChoices.delete(id)
  }
  showBriefPick()
  renderBrief(isReplay ? [] : card.changes.map(c => c.op === 'bottomLine' ? 'bottom line' : c.id))
  for (const change of card.changes) {
    const said = briefChangeLine(change, card.by)
    if (said) briefEvent(said, change.id)
  }
  if (!isReplay && card.by !== 'you') {
    answered()
    showTyping()
  }
  if (isFirst) showPane(paneChosen)
}

/** A line in the conversation saying what changed in the brief; it opens the brief at that section. */
function briefEvent(text, id) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'brief-event'
  el.textContent = text
  el.onclick = () => {
    showPane('brief')
    document.querySelector(`.sec[data-id="${CSS.escape(id ?? '')}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  const messages = $('messages')
  const isAtBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80
  messages.insertBefore(el, $('typing'))
  if (isAtBottom) messages.scrollTop = messages.scrollHeight
}

/** A section's state beside its title: open, assumed, settled, an idea, Claude's suggestion; and whose. */
function stateHtml(s) {
  const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`
  const mine = s.by === 'you' ? '<span class="from">from you</span>' : ''
  if (s.suggested) return pill('suggested', 'suggestion') + mine
  if (s.kind === 'idea') return pill('idea', 'idea') + mine
  if (s.kind !== 'constraint') return mine
  return pill(s.status, s.status) + mine
}

/** A constraint's choices (or Claude's suggestion, to take or not); a settled one says what was chosen, and by whom. */
function choicesHtml(s) {
  const button = (id, label, hint = '', isLean = false) =>
    `<button type="button" data-choose="${esc(id)}" class="${briefChoices.get(s.id) === id ? 'chosen' : ''}${isLean ? ' lean' : ''}">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}${isLean ? '<small class="leans">Claude leans here</small>' : ''}</button>`
  // A suggestion is taken, or taken by choosing one of its choices; or turned down.
  if (s.suggested) {
    const takes = s.kind === 'constraint' && s.choices?.length ? s.choices.map(c => button(c.id, c.label, c.hint, s.lean === c.id)) : [button('accept', 'Take it')]
    return `<div class="choices">${takes.join('')}${button('decline', 'Not now')}</div>`
  }
  if (s.kind !== 'constraint') return ''
  if (s.status === 'settled') {
    const label = s.choices?.find(c => c.id === s.chosen)?.label
    return `<div class="settled-line">✓ ${label ? esc(label) : 'Settled'}${s.settledBy === 'you' ? ' · your choice' : ' · Claude settled it from what you said'}</div>`
  }
  const buttons = (s.choices ?? []).map(c => button(c.id, c.label, c.hint, s.lean === c.id))
  // An assumption with no choices is confirmed as it stands, or turned down for Claude to ask.
  if (!buttons.length && s.status === 'assumed') buttons.push(button('', 'Confirm'), button('reject', 'Not this'))
  return buttons.length ? `<div class="choices">${buttons.join('')}</div>` : ''
}

/** How far a decision has got: one mark per constraint, settled, assumed or open. */
function progressHtml(b) {
  const constraints = b.sections.filter(s => s.kind === 'constraint' && !s.suggested)
  if (!constraints.length) return ''
  const n = st => constraints.filter(s => s.status === st).length
  return `<div class="progress">${constraints.map(s => `<i class="${s.status}"></i>`).join('')}<span>${n('settled')} settled · ${n('assumed')} assumed · ${n('open')} open</span></div>`
}

const citeHtml = c =>
  c.url
    ? `<a class="cite" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer" title="${esc(c.url)}">§ ${esc(c.label)}</a>`
    : `<span class="cite" title="Source: ${esc(c.label)}">§ ${esc(c.label)}</span>`

/** The brief on screen; `fresh` names what just changed, to mark it. */
function renderBrief(fresh = []) {
  const b = briefNow
  if (!b) return
  const keep = briefPane.scrollTop
  const isNewBottom = b.wasBottomLine && (briefSeen.get('bottom line') ?? 0) < b.v
  const sectionHtml = s => {
    const isNewLine = s.was && (briefSeen.get(s.id) ?? 0) < (s.lineV ?? 0)
    const asks = (s.asks ?? [])
      .map(a =>
        `<div class="qa">${a.question ? `<div class="q">You asked: <b>${esc(a.question)}</b></div>` : ''}` +
        (a.answer
          ? `<div class="a md">${markdown(a.answer)}</div>`
          : claudeState === 'working' || waitingCount()
            ? '<div class="a waiting"><span class="dots"><i></i><i></i><i></i></span> Waiting for Claude…</div>'
            : '<div class="a unanswered">Not answered here: Claude may have answered in the chat.</div>') +
        '</div>',
      )
      .join('')
    return (
      `<li class="sec${briefPick === s.id ? ' picked' : ''}${fresh.includes(s.id) ? ' fresh' : ''}${s.kind && s.kind !== 'point' ? ` k-${s.kind}` : ''}" data-id="${esc(s.id)}" tabindex="0">` +
      `<div class="sec-title">${esc(s.title)}${stateHtml(s)}</div>` +
      `<div class="line">${inline(s.line)}${(s.cites ?? []).map(citeHtml).join('')}${isNewLine ? '<span class="updated">updated</span>' : ''}</div>` +
      (isNewLine ? `<div class="was">${inline(s.was)}</div>` : '') +
      (s.body ? `<div class="body md">${markdown(s.body)}</div>` : '') +
      choicesHtml(s) +
      asks +
      (briefPick === s.id
        ? `<div class="sec-acts">${s.body ? '' : '<button type="button" data-act="more">More detail</button>'}<button type="button" data-act="ask">Ask about this</button></div>`
        : '') +
      '</li>'
    )
  }
  // A decision says what it waits on until every constraint is settled; then its bottom line is the proposal.
  const open = briefOpen()
  const isDecision = b.mode === 'decide'
  const toConfirm = b.sections.filter(s => s.kind === 'constraint' && s.status === 'assumed' && !s.suggested).length
  const confirm = toConfirm ? ` · ${toConfirm} to confirm` : ''
  const head = !isDecision
    ? 'Bottom line'
    : open.length
      ? `Bottom line · waiting on ${open.length}${confirm}`
      : b.isProposal
        ? `Bottom line · proposal${confirm}`
        : `Bottom line · all settled, waiting for Claude's proposal${confirm}`
  briefPane.innerHTML =
    `<div class="bottom-line${fresh.includes('bottom line') ? ' fresh' : ''}${isDecision && open.length ? ' waiting' : ''}"><div class="k">${head}${isNewBottom ? '<span class="updated">updated</span>' : ''}</div>` +
    `<p>${inline(b.bottomLine)}</p>${isNewBottom ? `<div class="was">${inline(b.wasBottomLine)}</div>` : ''}` +
    (isDecision && open.length ? `<div class="open-list">Open: ${open.map(s => esc(s.title)).join(', ')}</div>` : '') +
    '</div>' +
    (isDecision ? progressHtml(b) : '') +
    `<ol class="secs">${b.sections.map(sectionHtml).join('')}</ol>` +
    (b.dropped.length
      ? `<div class="dropped"><div class="k">Dropped</div>${b.dropped.map(s => `<div class="d"><s>${esc(s.title)}</s>${s.why ? ` <span>${esc(s.why)}</span>` : ''}</div>`).join('')}</div>`
      : '') +
    '<p class="brief-hint">Click a section to see what it is about on the diagram and to ask about it.</p>'
  briefPane.scrollTop = keep
  if (fresh.length && document.body.classList.contains('pane-brief')) {
    briefPane.querySelector('.fresh')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
  showFocus()
}

// ---------------------------------------------------------------- pointing at the diagram

/** The section being pointed at (hovered, or picked), whose boxes light up. */
let briefHover = null

/**
 * What a section points at in a drawing: a flowchart box or a chart's mark (as
 * sticky notes find them), else a sequence diagram's participant, its boxes
 * and lifeline.
 */
function focusIn(root, id) {
  const box = boxIn(root, id)
  if (box) return [box]
  return [...root.querySelectorAll('[name]')].filter(el => el.getAttribute('name') === id && el.matches('rect.actor, line.actor-line, g.actor-man'))
}

/** The latest diagram that has any of these boxes, chart labels or participants. */
const diagramWith = ids => diagrams.findLast(d => ids.some(id => focusIn(drawingOf(d), id).length))

/** Lights up the boxes the pointed-at section is about, on the diagram on screen. */
function showFocus() {
  canvas.classList.remove('brief-focus')
  canvas.querySelectorAll('.is-focus').forEach(el => el.classList.remove('is-focus'))
  // In a decision, each constraint's boxes say where it stands: open, assumed or settled.
  canvas.querySelectorAll('.st-open, .st-assumed, .st-settled').forEach(el => el.classList.remove('st-open', 'st-assumed', 'st-settled'))
  if (briefNow?.mode === 'decide') {
    for (const c of briefNow.sections.filter(x => x.kind === 'constraint' && !x.suggested && x.focus?.length)) {
      for (const el of c.focus.flatMap(on => focusIn(canvas, on))) el.classList.add(`st-${c.status}`)
    }
  }
  const id = briefHover ?? briefPick
  const s = briefNow?.sections.find(x => x.id === id)
  if (!s?.focus?.length) return
  const lit = s.focus.flatMap(on => focusIn(canvas, on))
  if (!lit.length) return
  canvas.classList.add('brief-focus')
  for (const el of lit) el.classList.add('is-focus')
}

/** Brings up the diagram a section is about, when the one on screen does not have its boxes. */
function showDiagramOf(s) {
  if (!s?.focus?.length || s.focus.some(on => focusIn(canvas, on).length)) return
  const d = diagramWith(s.focus)
  if (d) select(diagrams.indexOf(d))
}

briefPane.addEventListener('mouseover', e => {
  const li = e.target.closest('.sec')
  const id = li?.dataset.id ?? null
  if (id === briefHover) return
  briefHover = id
  showFocus()
})
briefPane.addEventListener('mouseleave', () => {
  briefHover = null
  showFocus()
})

// ---------------------------------------------------------------- picking and asking

/** Picks a section (or unpicks it): its line is marked seen, and it goes with the next message. */
function pickSection(id) {
  briefPick = briefPick === id ? null : id
  const s = briefNow?.sections.find(x => x.id === id)
  if (s) briefSeen.set(id, s.v)
  if (briefPick) showDiagramOf(s)
  renderBrief()
  showBriefPick()
}

/** The composer says what the next message is about, and which choices go with it. */
function showBriefPick() {
  const s = briefNow?.sections.find(x => x.id === briefPick)
  const tag = $('about')
  tag.hidden = !s
  if (s) $('about-text').textContent = `About “${s.title}”: goes with your next message`
  const said = briefChoicesSaid()
  $('choices-tag').hidden = !said
  $('choices-text').textContent = said ? `${said} Goes with your next message (Send alone sends them).` : ''
}

/** The person's choices, in words: "Accounts: Guest checkout; Payments: Hosted page." */
function briefChoicesSaid() {
  const parts = []
  for (const [id, choice] of briefChoices) {
    const s = briefNow?.sections.find(x => x.id === id)
    if (!s) continue
    const label = choice === 'accept' ? 'take it' : choice === 'decline' ? 'not now' : choice === 'reject' ? 'not this' : choice === '' ? 'confirmed' : s.choices?.find(c => c.id === choice)?.label
    if (!label) continue
    parts.push(`${s.title}: ${label}`)
  }
  return parts.length ? `My choices on the board: ${parts.join('; ')}.` : ''
}
/** The choices that go with a message, for the board. */
const briefChoicesToSend = () => [...briefChoices].map(([id, choice]) => ({ id, ...(choice ? { choice } : {}) }))
/** The message went: its choices are taken off. */
function briefChoicesSent() {
  briefChoices.clear()
  renderBrief()
  showBriefPick()
}
$('choices-clear').onclick = () => {
  briefChoices.clear()
  renderBrief()
  showBriefPick()
}
$('about-clear').onclick = () => {
  briefPick = null
  renderBrief()
  showBriefPick()
}

/** What a message says about the picked section, for Claude; and the section, for the board. */
function briefAbout() {
  const s = briefNow?.sections.find(x => x.id === briefPick)
  return s ? briefAboutOf(s) : null
}
const briefAboutOf = s => ({ id: s.id, said: `About the brief's section \`${s.id}\` ("${s.title}": ${s.line}):` })
/** After a message: the pick went with it. */
function briefSent() {
  briefPick = null
  renderBrief()
  showBriefPick()
}

briefPane.addEventListener('click', e => {
  if (e.target.closest('a') || isEnded) return
  const li = e.target.closest('.sec')
  if (!li) return
  const choose = e.target.closest('[data-choose]')
  if (choose) {
    const id = li.dataset.id
    // Picked again: not chosen after all.
    if (briefChoices.get(id) === choose.dataset.choose) briefChoices.delete(id)
    else briefChoices.set(id, choose.dataset.choose)
    renderBrief()
    showBriefPick()
    return
  }
  const act = e.target.closest('[data-act]')?.dataset.act
  if (act === 'ask') {
    $('text').focus()
    return
  }
  if (act === 'more') {
    const s = briefNow.sections.find(x => x.id === li.dataset.id)
    send('More detail, please.', false, { ...briefAboutOf(s), said: `${briefAboutOf(s).said} (write it as the section's body)`, asked: 'More detail, please.', isMore: true })
    return
  }
  if (e.target.closest('.qa, .body')) return
  pickSection(li.dataset.id)
})
briefPane.addEventListener('keydown', e => {
  const li = e.target.closest?.('.sec')
  if (li && (e.key === 'Enter' || e.key === ' ') && e.target === li) {
    e.preventDefault()
    pickSection(li.dataset.id)
  }
})
