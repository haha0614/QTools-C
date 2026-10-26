(() => {
  const input = document.querySelector('.pl-head .pl-input')
  const err = document.querySelector('.pl-new__err')
  const page = document.querySelector('.pl-page')
  const pcs = getComputedStyle(page)
  const toasts = Array.from(document.querySelectorAll('.ms-toast')).map((t) => t.textContent.trim())
  const names = Array.from(document.querySelectorAll('.pl-side .pl-name')).map((n) => n.textContent.trim())
  const cs = getComputedStyle(input)
  return {
    value: input.value,
    maxlength: input.getAttribute('maxlength'),
    invalid: input.classList.contains('is-invalid'),
    ariaInvalid: input.getAttribute('aria-invalid'),
    borderColor: cs.borderColor,
    borderStyle: cs.borderTopStyle,
    err: err ? err.textContent.trim() : '',
    errColor: err ? getComputedStyle(err).color : '',
    dangerToken: pcs.getPropertyValue('--danger').trim(),
    lineToken: pcs.getPropertyValue('--line').trim(),
    pageBg: pcs.backgroundColor,
    toasts,
    names,
    listCount: names.length
  }
})()