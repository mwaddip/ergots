/** SANTA canonical JSON value type — shared by encode and stype bridges. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
