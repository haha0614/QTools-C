
import io
p='src/views/media/PersonsPage.vue'
s=io.open(p,encoding='utf-8').read()
s=s.replace("""  width: 38%;
  z-index: 1;
  pointer-events: none;
  border-radius: inherit;
  background: linear-gradient(to right, rgba(255, 255, 255, 0.55) 0%, rgba(255, 255, 255, 0.42) 40%, rgba(255, 255, 255, 0) 78%);""",
"""  width: 70%;
  z-index: 1;
  pointer-events: none;
  border-radius: inherit;
  background: linear-gradient(to right, rgba(255, 255, 255, 0.62) 0%, rgba(255, 255, 255, 0.5) 60%, rgba(255, 255, 255, 0.38) 100%);""")
s=s.replace("""  background: linear-gradient(to right, rgba(255, 255, 255, 0.62) 0%, rgba(255, 255, 255, 0.48) 40%, rgba(255, 255, 255, 0) 78%);
}""",
"""  background: linear-gradient(to right, rgba(255, 255, 255, 0.78) 0%, rgba(255, 255, 255, 0.66) 60%, rgba(255, 255, 255, 0.52) 100%);
}""")
s=s.replace("""  background: linear-gradient(to right, rgba(0, 0, 0, 0.5) 0%, rgba(0, 0, 0, 0.38) 40%, rgba(0, 0, 0, 0) 78%);""",
"""  background: linear-gradient(to right, rgba(0, 0, 0, 0.58) 0%, rgba(0, 0, 0, 0.46) 60%, rgba(0, 0, 0, 0.34) 100%);""")
s=s.replace("""html.dark .pw-scrim.is-strong {
  background: linear-gradient(to right, rgba(0, 0, 0, 0.62) 0%, rgba(0, 0, 0, 0.48) 40%, rgba(0, 0, 0, 0) 78%);
}""",
"""html.dark .pw-scrim.is-strong {
  background: linear-gradient(to right, rgba(0, 0, 0, 0.74) 0%, rgba(0, 0, 0, 0.6) 60%, rgba(0, 0, 0, 0.46) 100%);
}""")
io.open(p,'w',encoding='utf-8',newline='').write(s)
print('ok')
