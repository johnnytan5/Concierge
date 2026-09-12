'use client'
import { useState } from 'react'
import { useRealtimeTable } from '@/lib/useRealtimeTable'
import styles from './page.module.css'

type Item = {
  id: string
  name: string
  category: string
  price: number | null
  dietary_tags: string[]
  available: boolean
  stock_count: number | null
}

const API = 'http://localhost:8000'

export default function AdminPage() {
  const [password, setPassword] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const items = useRealtimeTable<Item>('inventory_items', 'name')
  const [newItem, setNewItem] = useState({ name: '', category: 'amenity', price: '' })

  async function addItem() {
    await fetch(`${API}/admin/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
      body: JSON.stringify({
        name: newItem.name,
        category: newItem.category,
        price: newItem.price ? parseFloat(newItem.price) : null,
      }),
    })
    setNewItem({ name: '', category: 'amenity', price: '' })
  }

  async function patchItem(id: string, fields: Partial<Item>) {
    await fetch(`${API}/admin/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
      body: JSON.stringify(fields),
    })
  }

  async function toggleAvailable(item: Item) {
    await patchItem(item.id, { available: !item.available })
  }

  async function deleteItem(id: string) {
    await fetch(`${API}/admin/items/${id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Password': password },
    })
  }

  if (!unlocked) {
    return (
      <main className="pageMain">
        <div className={styles.gateWrap}>
          <div className={styles.gateBox}>
            <span className={styles.gateTag}>
              <span className={styles.gateDot} />
              {'// Concierge Admin — Restricted'}
            </span>
            <h1 className={styles.gateTitle}>Admin</h1>
            <input
              type="password"
              placeholder="Admin password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={styles.passwordInput}
            />
            <button onClick={() => setUnlocked(true)} className={styles.unlockButton}>
              Unlock
            </button>
          </div>
        </div>
      </main>
    )
  }

  return (
    <main className="pageMain">
      <header className="pageHeader">
        <span className="pageTag">{'// Concierge Admin'}</span>
        <h1 className="pageTitle">Inventory</h1>
        <span className="pageStatus">
          <span className="statusDot" />
          Realtime Feed
        </span>
      </header>

      <div className={styles.tableWrap}>
        <table className={styles.table} cellPadding={8}>
          <thead>
            <tr>
              <th>Name</th><th>Category</th><th>Price</th><th>Available</th><th>Stock</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.name}</td>
                <td>{item.category}</td>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    defaultValue={item.price ?? ''}
                    className={styles.priceInput}
                    onBlur={(e) =>
                      patchItem(item.id, { price: e.target.value ? parseFloat(e.target.value) : null })
                    }
                  />
                </td>
                <td>
                  <button
                    onClick={() => toggleAvailable(item)}
                    className={`${styles.availButton} ${item.available ? styles.available : styles.unavailable}`}
                  >
                    {item.available ? 'Available' : 'Unavailable'}
                  </button>
                </td>
                <td>
                  <input
                    type="number"
                    defaultValue={item.stock_count ?? ''}
                    placeholder="∞"
                    className={styles.stockInput}
                    onBlur={(e) =>
                      patchItem(item.id, { stock_count: e.target.value ? parseInt(e.target.value) : null })
                    }
                  />
                </td>
                <td>
                  <button onClick={() => deleteItem(item.id)} className={styles.deleteButton}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className={styles.addSection}>
        <h2 className={styles.addTitle}>Add item</h2>
        <div className={styles.addRow}>
          <input
            placeholder="name"
            value={newItem.name}
            onChange={(e) => setNewItem({ ...newItem, name: e.target.value })}
            className={styles.textInput}
          />
          <select
            value={newItem.category}
            onChange={(e) => setNewItem({ ...newItem, category: e.target.value })}
            className={styles.select}
          >
            <option value="amenity">amenity</option>
            <option value="food">food</option>
            <option value="beverage">beverage</option>
          </select>
          <input
            placeholder="price (optional)"
            value={newItem.price}
            onChange={(e) => setNewItem({ ...newItem, price: e.target.value })}
            className={styles.textInput}
          />
          <button onClick={addItem} className={styles.unlockButton}>
            Add
          </button>
        </div>
      </section>
    </main>
  )
}
