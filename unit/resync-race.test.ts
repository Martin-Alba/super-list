import { describe, it, expect } from 'vitest'
import { mergeItems, type Item } from '../lib/items'

// J6 / DoD 41 — el refresco cruza un `await`. Los eventos que llegan durante la
// peticion ya estan en el estado; sustituir la lista por la respuesta los
// borraria hasta el siguiente evento, y dos personas comprando divergirian sin
// que nada lo delate.
const item = (id: string, updated: string, extra: Partial<Item> = {}): Item => ({
  id, group_id: 'g', name: id, quantity: null, created_by: 'u',
  created_at: '2026-01-01T00:00:00Z', updated_at: updated, deleted_at: null, origen_id: null, ...extra,
})

describe('J6 el refresco no se come los eventos en vuelo', () => {
  it('un item llegado durante la peticion sobrevive al refresco', () => {
    const fresh = [item('a', '2026-01-01T00:00:01Z')]
    const current = [item('a', '2026-01-01T00:00:01Z'), item('b', '2026-01-01T00:00:05Z')]
    expect(mergeItems(fresh, current).map(i => i.id)).toEqual(['a', 'b'])
  })

  it('gana la version mas reciente de cada item', () => {
    const fresh = [item('a', '2026-01-01T00:00:01Z', { name: 'viejo' })]
    const current = [item('a', '2026-01-01T00:00:09Z', { name: 'nuevo' })]
    expect(mergeItems(fresh, current)[0].name).toBe('nuevo')
  })

  it('no resucita lo que el servidor da por borrado si nadie lo toco despues', () => {
    const fresh: Item[] = []
    const current = [item('a', '2026-01-01T00:00:01Z', { deleted_at: '2026-01-01T00:00:02Z' })]
    expect(mergeItems(fresh, current)).toEqual([])
  })

  it('la respuesta del servidor manda cuando es la mas reciente', () => {
    const fresh = [item('a', '2026-01-01T00:00:09Z', { name: 'del servidor' })]
    const current = [item('a', '2026-01-01T00:00:01Z', { name: 'local viejo' })]
    expect(mergeItems(fresh, current)[0].name).toBe('del servidor')
  })
})
