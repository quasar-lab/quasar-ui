import useQuasarStore from '../stores/useQuasarStore'

import { PublicKey } from '@solana/web3.js'
import { notify } from '../utils/notifications'
import { useState } from 'react'

const AddBaseTokenForm = () => {
  const quasarClient = useQuasarStore((s) => s.connection.client)
  const quasarGroup = useQuasarStore((s) => s.quasarGroup)

  const [mint, setMint] = useState('')
  const [oracle, setOracle] = useState('')

  const handleTextChange =
    (setFn) =>
    ({ target: { value } }) =>
      setFn(value)

  const addBaseToken = async () => {
    const wallet = useQuasarStore.getState().wallet.current

    try {
      await quasarClient.addBaseToken(
        quasarGroup.publicKey,
        new PublicKey(mint),
        new PublicKey(oracle),
        wallet,
      )
      notify({
        title: 'base token added',
      })
    } catch (err) {
      console.warn('Error adding base token:', err)
      notify({
        title: 'Could not add a base token',
        description: `${err}`,
        type: 'error',
      })
    }
  }

  return (
    <>
      <div className="m-4">
        <div>
          <label>token mint</label>
          <input
            className={`border`}
            type="text"
            name="mint"
            value={mint}
            onChange={handleTextChange(setMint)}
          />
        </div>
        <div>
          <label>oracle</label>
          <input
            className={`border`}
            type="text"
            name="oracle"
            value={oracle}
            onChange={handleTextChange(setOracle)}
          />
        </div>
        <button
          className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
          onClick={() => addBaseToken()}
        >
          add base token
        </button>
      </div>
    </>
  )
}

export default AddBaseTokenForm
