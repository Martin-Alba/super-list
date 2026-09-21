import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql } from './helpers'

/**
 * J7 / DoD 42 — sin cota, un miembro legítimo mete 200 000 caracteres y
 * Realtime los difunde a todos los suscriptores. Con 500 MB de base y 2 M de
 * mensajes al mes en el plan gratuito, es una palanca de agotamiento que no
 * necesita ni un atacante: basta un pegado accidental.
 */
describe('J7 cota de longitud en los textos', () => {
  it('rechaza un nombre de ítem de 201 caracteres y acepta 200', async () => {
    const owner = await newUser('ll-owner')
    const gid = await newGroup(owner)

    const tooLong = await owner.client.from('items')
      .insert({ group_id: gid, name: 'a'.repeat(201), created_by: owner.id })
    expect(tooLong.error, 'entró un nombre de 201 caracteres').not.toBeNull()

    const ok = await owner.client.from('items')
      .insert({ group_id: gid, name: 'a'.repeat(200), created_by: owner.id })
    expect(ok.error).toBeNull()
  })

  /**
   * Spec J / valla — **La cota de longitud de `quantity` queda SUBSUMIDA, y eso se escribe
   * en vez de borrarse.**
   *
   * La spec predijo que esta fila «se conserva» si J-R1 añadía un `check`. La predicción era
   * medio falsa y la medida lo dijo: la mitad negativa sigue siendo verdad —51 caracteres no
   * entran—, pero **la positiva ya no es observable**. No existe ningún valor que
   * `items_quantity_len` rechace y `items_quantity_num` acepte, así que el límite exacto en
   * 50 no se puede ver desde fuera; `'q'.repeat(50)` ahora lo rechaza el `check` numérico,
   * como debe.
   *
   * Qué se conserva, entonces, y por qué no es un test vacío:
   * - la mitad negativa, que es la que se pone roja si alguien quita las dos restricciones;
   * - un caso que **sí** entra (`'99'`), porque sin él «rechaza lo largo» no se distingue de
   *   «rechaza todo» — es la sonda de §E.2, y es exactamente la que la versión anterior
   *   cubría con el caso de 50;
   * - y la existencia de `items_quantity_len` en el catálogo, porque el día que el `check`
   *   numérico se retire, la cota vuelve a ser lo único que para un pegado de 200.000
   *   caracteres. Afirmarla estructuralmente es lo único que queda cuando su efecto está
   *   tapado por una regla más estricta.
   */
  it('una cantidad de 51 caracteres no entra, y la cota sigue declarada', async () => {
    const owner = await newUser('ll-owner2')
    const gid = await newGroup(owner)

    const tooLong = await owner.client.from('items')
      .insert({ group_id: gid, name: 'pan', quantity: 'q'.repeat(51), created_by: owner.id })
    expect(tooLong.error, 'entró una cantidad de 51 caracteres').not.toBeNull()

    // La sonda: sin un caso que entre, «rechaza lo largo» y «rechaza todo» son lo mismo.
    const ok = await owner.client.from('items')
      .insert({ group_id: gid, name: 'pan2', quantity: '99', created_by: owner.id })
    expect(ok.error, 'no entra ninguna cantidad: el test no distingue nada').toBeNull()

    /**
     * k6 — Se afirma **el valor**, no el nombre. Conservarla por el nombre dejaba cambiarla a
     * 5.000 sin que nada se pusiera rojo, y el motivo escrito para conservarla —parar un
     * pegado de 200.000 caracteres el día que el check numérico se retire— es justo donde el
     * número es lo único que importa.
     */
    const [cota] = await sql<{ def: string }>(`select pg_get_constraintdef(oid) as def
      from pg_constraint where conrelid = 'public.items'::regclass
        and conname = 'items_quantity_len'`)
    expect(cota, 'la cota de longitud desapareció, y su efecto lo tapa otra regla').toBeDefined()
    // m3 — **Con el paréntesis.** `toContain('<= 50')` es un prefijo: `<= 5000` lo contiene,
    // así que la cota se podía subir a 5.000 sin un solo rojo — que es literalmente la mutación
    // que i2-R5 decía cerrar. Un carácter separa afirmar el límite de afirmar su primer dígito.
    expect(cota.def, 'la cota sigue ahí con otro número: el nombre se conservó y el límite no')
      .toContain('<= 50)')
  })

  it('rechaza un nombre de grupo de 201 caracteres', async () => {
    const owner = await newUser('ll-owner3')
    const { error } = await owner.client.rpc('create_group', { p_name: 'g'.repeat(201) })
    expect(error).not.toBeNull()
  })

  it('el gigante de 200 000 caracteres que el review midió ya no entra', async () => {
    const owner = await newUser('ll-owner4')
    const gid = await newGroup(owner)
    const { error } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'x'.repeat(200_000), created_by: owner.id })
    expect(error).not.toBeNull()
  })
})
