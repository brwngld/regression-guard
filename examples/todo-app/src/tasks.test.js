import { describe, expect, it } from 'vitest'
import {
  addTask,
  clearCompleted,
  deleteTask,
  editTask,
  getFilteredTasks,
  loadTasks,
  saveTasks,
  toggleTask,
} from './tasks'

describe('task operations', () => {
  it('adds tasks and rejects blank entries', () => {
    const tasks = addTask([], 'Buy milk', () => '1')
    expect(tasks).toEqual([{ id: '1', text: 'Buy milk', completed: false }])

    expect(() => addTask(tasks, '   ')).toThrow('Task cannot be blank.')
  })

  it('toggles, edits and deletes tasks', () => {
    const initial = [
      { id: '1', text: 'A', completed: false },
      { id: '2', text: 'B', completed: true },
    ]

    const toggled = toggleTask(initial, '1')
    expect(toggled[0].completed).toBe(true)

    const edited = editTask(toggled, '2', 'Renamed')
    expect(edited[1].text).toBe('Renamed')

    const deleted = deleteTask(edited, '1')
    expect(deleted).toEqual([{ id: '2', text: 'Renamed', completed: true }])
  })

  it('filters and clears completed tasks', () => {
    const tasks = [
      { id: '1', text: 'A', completed: false },
      { id: '2', text: 'B', completed: true },
      { id: '3', text: 'C', completed: false },
    ]

    expect(getFilteredTasks(tasks, 'active').map((task) => task.id)).toEqual(['1', '3'])
    expect(getFilteredTasks(tasks, 'completed').map((task) => task.id)).toEqual(['2'])
    expect(clearCompleted(tasks).map((task) => task.id)).toEqual(['1', '3'])
  })
})

describe('storage persistence', () => {
  it('saves and loads tasks from localStorage-like storage', () => {
    const store = new Map()
    const storage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    }

    const tasks = [{ id: '1', text: 'Persist me', completed: false }]
    saveTasks(tasks, storage, 'test-key')

    expect(loadTasks(storage, 'test-key')).toEqual(tasks)
  })

  it('returns empty list for invalid persisted payloads', () => {
    const storage = {
      getItem: () => '{bad json',
      setItem: () => {},
    }

    expect(loadTasks(storage, 'test-key')).toEqual([])
  })
})
