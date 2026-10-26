function () {
  const el = document.querySelector('.pl-head .pl-input')
  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
  return true
}