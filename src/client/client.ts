import {
  Account,
  AccountInfo,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SimulatedTransactionResponse,
  SystemProgram,
  Transaction,
  TransactionConfirmationStatus,
  TransactionSignature,
  SYSVAR_RENT_PUBKEY,
  Keypair,
} from '@solana/web3.js'
import BN from 'bn.js'
import {
  awaitTransactionSignatureConfirmation,
  createAccountInstruction,
  createSignerKeyAndNonce,
  createTokenAccountInstructions,
  simulateTransaction,
  sleep,
  zeroKey,
  ZERO_BN,
} from './utils'
import { QuasarGroupLayout, StubOracleLayout } from './layout'
import {
  makeInitQuasarGroupInstruction,
  makeAddBaseTokenInstruction,
  makeAddLeverageTokenInstruction,
} from './instruction'
import { I80F48, MangoAccountLayout } from '@blockworks-foundation/mango-client'

import { WalletAdapter } from '../@types/types'
import {
  closeAccount,
  initializeAccount,
  WRAPPED_SOL_MINT,
} from '@project-serum/serum/lib/token-instructions'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Token,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import QuasarGroup from './QuasarGroup'

export const getUnixTs = () => {
  return new Date().getTime() / 1000
}

export class QuasarClient {
  connection: Connection
  programId: PublicKey

  constructor(connection: Connection, programId: PublicKey) {
    this.connection = connection
    this.programId = programId
  }

  async sendTransactions(
    transactions: Transaction[],
    payer: Account | WalletAdapter,
    additionalSigners: Account[],
    timeout = 30000,
    confirmLevel: TransactionConfirmationStatus = 'confirmed',
  ): Promise<TransactionSignature[]> {
    return await Promise.all(
      transactions.map((tx) =>
        this.sendTransaction(
          tx,
          payer,
          additionalSigners,
          timeout,
          confirmLevel,
        ),
      ),
    )
  }

  async signTransaction({ transaction, payer, signers }) {
    transaction.recentBlockhash = (
      await this.connection.getRecentBlockhash()
    ).blockhash
    transaction.setSigners(payer.publicKey, ...signers.map((s) => s.publicKey))
    if (signers.length > 0) {
      transaction.partialSign(...signers)
    }

    if (payer?.connected) {
      console.log('signing as wallet', payer.publicKey)
      return await payer.signTransaction(transaction)
    } else {
      transaction.sign(...[payer].concat(signers))
    }
  }

  async signTransactions({
    transactionsAndSigners,
    payer,
  }: {
    transactionsAndSigners: {
      transaction: Transaction
      signers?: Array<Account>
    }[]
    payer: Account | WalletAdapter
  }) {
    const blockhash = (await this.connection.getRecentBlockhash('max'))
      .blockhash
    transactionsAndSigners.forEach(({ transaction, signers = [] }) => {
      transaction.recentBlockhash = blockhash
      transaction.setSigners(
        payer.publicKey,
        ...signers.map((s) => s.publicKey),
      )
      if (signers?.length > 0) {
        transaction.partialSign(...signers)
      }
    })
    if (!(payer instanceof Account)) {
      return await payer.signAllTransactions(
        transactionsAndSigners.map(({ transaction }) => transaction),
      )
    } else {
      transactionsAndSigners.forEach(({ transaction, signers }) => {
        transaction.sign(...[payer].concat(signers))
      })
    }
  }

  // TODO - switch Account to Keypair and switch off setSigners due to deprecated
  async sendTransaction(
    transaction: Transaction,
    payer: Account | WalletAdapter,
    additionalSigners: Account[],
    timeout = 30000,
    confirmLevel: TransactionConfirmationStatus = 'processed',
    postSignTxCallback?: any,
  ): Promise<TransactionSignature> {
    await this.signTransaction({
      transaction,
      payer,
      signers: additionalSigners,
    })

    const rawTransaction = transaction.serialize()
    const startTime = getUnixTs()
    if (postSignTxCallback) {
      try {
        postSignTxCallback()
      } catch (e) {
        console.log(`postSignTxCallback error ${e}`)
      }
    }
    const txid: TransactionSignature = await this.connection.sendRawTransaction(
      rawTransaction,
      { skipPreflight: true },
    )

    console.log(
      'Started awaiting confirmation for',
      txid,
      'size:',
      rawTransaction.length,
    )

    let done = false
    ;(async () => {
      // TODO - make sure this works well on mainnet
      await sleep(1000)
      while (!done && getUnixTs() - startTime < timeout / 1000) {
        console.log(new Date().toUTCString(), ' sending tx ', txid)
        this.connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
        })
        await sleep(2000)
      }
    })()

    try {
      await awaitTransactionSignatureConfirmation(
        txid,
        timeout,
        this.connection,
        confirmLevel,
      )
    } catch (err) {
      if (err.timeout) {
        throw new Error('Timed out awaiting confirmation on transaction')
      }
      let simulateResult: SimulatedTransactionResponse | null = null
      try {
        simulateResult = (
          await simulateTransaction(this.connection, transaction, 'processed')
        ).value
      } catch (e) {
        console.warn('Simulate transaction failed')
      }

      if (simulateResult && simulateResult.err) {
        if (simulateResult.logs) {
          for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
            const line = simulateResult.logs[i]
            if (line.startsWith('Program log: ')) {
              throw new Error(
                'Transaction failed: ' + line.slice('Program log: '.length),
              )
            }
          }
        }
        throw new Error(JSON.stringify(simulateResult.err))
      }
      throw new Error('Transaction failed')
    } finally {
      done = true
    }

    // console.log('Latency', txid, getUnixTs() - startTime);
    return txid
  }

  async sendSignedTransaction({
    signedTransaction,
    timeout = 30000,
    confirmLevel = 'processed',
  }: {
    signedTransaction: Transaction
    timeout?: number
    confirmLevel?: TransactionConfirmationStatus
  }): Promise<string> {
    const rawTransaction = signedTransaction.serialize()
    const startTime = getUnixTs()

    const txid: TransactionSignature = await this.connection.sendRawTransaction(
      rawTransaction,
      {
        skipPreflight: true,
      },
    )

    // console.log('Started awaiting confirmation for', txid);

    let done = false
    ;(async () => {
      await sleep(500)
      while (!done && getUnixTs() - startTime < timeout) {
        this.connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
        })
        await sleep(500)
      }
    })()
    try {
      await awaitTransactionSignatureConfirmation(
        txid,
        timeout,
        this.connection,
        confirmLevel,
      )
    } catch (err) {
      if (err.timeout) {
        throw new Error('Timed out awaiting confirmation on transaction')
      }
      let simulateResult: SimulatedTransactionResponse | null = null
      try {
        simulateResult = (
          await simulateTransaction(
            this.connection,
            signedTransaction,
            'single',
          )
        ).value
      } catch (e) {
        console.log('Simulate tx failed')
      }
      if (simulateResult && simulateResult.err) {
        if (simulateResult.logs) {
          for (let i = simulateResult.logs.length - 1; i >= 0; --i) {
            const line = simulateResult.logs[i]
            if (line.startsWith('Program log: ')) {
              throw new Error(
                'Transaction failed: ' + line.slice('Program log: '.length),
              )
            }
          }
        }
        throw new Error(JSON.stringify(simulateResult.err))
      }
      throw new Error('Transaction failed')
    } finally {
      done = true
    }

    // console.log('Latency', txid, getUnixTs() - startTime);
    return txid
  }

  async initQuasarGroup(
    mangoProgram: PublicKey,
    payer: Account | WalletAdapter,
  ): Promise<PublicKey> {
    const accountInstruction = await createAccountInstruction(
      this.connection,
      payer.publicKey,
      QuasarGroupLayout.span,
      this.programId,
    )
    const { signerKey, signerNonce } = await createSignerKeyAndNonce(
      this.programId,
      accountInstruction.keypair.publicKey,
    )

    const createAccountsTransaction = new Transaction()
    createAccountsTransaction.add(accountInstruction.instruction)

    const signers = [new Account(accountInstruction.keypair.secretKey)]
    await this.sendTransaction(createAccountsTransaction, payer, signers)

    const initQuasarGroupInstruction = makeInitQuasarGroupInstruction(
      this.programId,
      accountInstruction.keypair.publicKey,
      signerKey,
      payer.publicKey,
      mangoProgram,
      new BN(signerNonce),
    )

    const initQuasarGroupTransaction = new Transaction()
    initQuasarGroupTransaction.add(initQuasarGroupInstruction)
    await this.sendTransaction(initQuasarGroupTransaction, payer, [])

    return accountInstruction.keypair.publicKey
  }

  async getQuasarGroup(quasarGroup: PublicKey): Promise<QuasarGroup> {
    const accountInfo = await this.connection.getAccountInfo(quasarGroup)
    const decoded = QuasarGroupLayout.decode(
      accountInfo == null ? undefined : accountInfo.data,
    )

    return new QuasarGroup(quasarGroup, decoded)
  }

  async addBaseToken(
    quasarGroupPk: PublicKey,
    mintPk: PublicKey,
    oraclePk: PublicKey,
    admin: Account | WalletAdapter,
  ): Promise<TransactionSignature> {
    const addBaseTokenInstruction = makeAddBaseTokenInstruction(
      this.programId,
      quasarGroupPk,
      mintPk,
      oraclePk,
      admin.publicKey,
    )

    const addBaseTokenTransaction = new Transaction()
    addBaseTokenTransaction.add(addBaseTokenInstruction)
    return await this.sendTransaction(addBaseTokenTransaction, admin, [])
  }

  //  [quasar_group_ai, mint_ai, base_token_mint_ai, mango_program_ai, mango_group_ai, mango_account_ai, mango_perp_market_ai, system_program_ai, token_program_ai, rent_program_ai, admin_ai] =
  async addLeverageToken(
    quasarGroupPk: PublicKey,
    baseTokenMintPk: PublicKey,
    mangoProgram: PublicKey,
    mangoGroup: PublicKey,
    mangoPerpMarket: PublicKey,
    admin: Account | WalletAdapter,
    targetLeverage: I80F48,
  ): Promise<PublicKey> {
    const mintKeypair = new Keypair()

    const mangoAccountInstruction = await createAccountInstruction(
      this.connection,
      admin.publicKey,
      MangoAccountLayout.span,
      mangoProgram,
    )
    console.log(mangoAccountInstruction.keypair.publicKey.toString())

    const quasarGroup = await this.getQuasarGroup(quasarGroupPk)
    const addLeverageTokenInstruction = makeAddLeverageTokenInstruction(
      this.programId,
      quasarGroupPk,
      mintKeypair.publicKey,
      baseTokenMintPk,
      mangoProgram,
      mangoGroup,
      mangoAccountInstruction.keypair.publicKey,
      mangoPerpMarket,
      admin.publicKey,
      quasarGroup.signerKey,
      targetLeverage,
    )

    const addLeverageTokenTransaction = new Transaction()
    addLeverageTokenTransaction.add(
      mangoAccountInstruction.instruction,
      addLeverageTokenInstruction,
    )

    const signers = [
      new Account(mangoAccountInstruction.keypair.secretKey),
      new Account(mintKeypair.secretKey),
    ]
    await this.sendTransaction(addLeverageTokenTransaction, admin, signers)

    return mintKeypair.publicKey
  }
}
