/**
 * The label scanner lives in the shared layer, where the writer view can use the
 * same reading of a script as everything here. Re-exported so nothing in the
 * core has to know it moved.
 */
export * from '@shared/renpy/labels'
