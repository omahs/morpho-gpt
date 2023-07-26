import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { OpenAI } from "langchain/llms/openai";
import { loadQAStuffChain } from "langchain/chains";
import { Document } from "langchain/document";
import { PineconeClient } from "@pinecone-database/pinecone";
import { QueryResponse as PineconeQueryResponse } from "@pinecone-database/pinecone/dist/pinecone-generated-ts-fetch/models/QueryResponse";
import { VectorOperationsApi } from "@pinecone-database/pinecone/dist/pinecone-generated-ts-fetch";
import {
  MyScoredVector,
  PineconeClientParams,
  QueryResponse,
  Vector,
} from "./interfaces";

/**
 * Creates a new Pinecone client and initializes it with the given parameters.
 * @param {PineconeClientParams} params - The parameters to initialize the Pinecone client with.
 * @returns {PineconeClient} - The created and initialized Pinecone client.
 */
export function createPineconeClient(
  params: PineconeClientParams
): PineconeClient {
  const client = new PineconeClient();
  client.init(params);
  return client;
}

/**
 * Queries the Pinecone vector store with a given question, returning the store's response.
 * @param {PineconeClient} client - The Pinecone client to use for querying.
 * @param {string} indexName - The name of the index to query.
 * @param {string} question - The question to embed and query the vector store with.
 * @returns {Promise<PineconeQueryResponse>} - The response from the Pinecone vector store.
 */
export const queryPineconeVectorStore = async (
  client: PineconeClient,
  indexName: string,
  question: string
): Promise<PineconeQueryResponse> => {
  console.log("Querying Pinecone vector store...");
  const index = client.Index(indexName);
  const queryEmbedding = await new OpenAIEmbeddings().embedQuery(question);
  const pineconeResponse = await index.query({
    queryRequest: {
      topK: 10,
      vector: queryEmbedding,
      includeMetadata: true,
      includeValues: true,
    },
  });

  return pineconeResponse;
};

/**
 * Formats the response from a Pinecone query to match the QueryResponse interface.
 * @param {PineconeQueryResponse} pineconeResponse - The original response from the Pinecone query.
 * @returns {QueryResponse} - The formatted query response.
 */
export const formatPineconeResponse = (
  pineconeResponse: PineconeQueryResponse
): QueryResponse => {
  let queryResponse: QueryResponse = {
    matches: pineconeResponse.matches?.map((match) => {
      if (
        match.metadata &&
        "pageContent" in match.metadata &&
        "docLink" in match.metadata
      ) {
        const ret: MyScoredVector = {
          ...match,
          metadata: {
            pageContent: (match.metadata as any).pageContent,
            docLink: (match.metadata as any).docLink,
          },
        };
        return ret;
      } else {
        return match as MyScoredVector;
      }
    }),
    namespace: pineconeResponse.namespace,
  };

  return queryResponse;
};

/**
 * Queries a language model with the response from a Pinecone query and a question, returning the model's answer.
 * @param {QueryResponse} queryResponse - The formatted response from the Pinecone query.
 * @param {string} question - The question to ask the language model.
 * @param {string} openAIApiKey - The API key to use for the OpenAI language model.
 * @returns {Promise<{answer: string, documentLinks: string[]}>} - The model's answer and the document links.
 */
export const queryLanguageModelWithPineconeResponse = async (
  queryResponse: QueryResponse,
  question: string,
  openAIApiKey: string
) => {
  console.log(`Asking question: ${question}...`);
  if (queryResponse?.matches?.length) {
    console.log(`Found ${queryResponse.matches.length} matches...`);
    const instructions =
      "You're an AI assistant. Based on the following excerpts from a long document, provide a conversational answer to the question asked. If the answer isn't in the context, simply respond with 'Hmm, I'm not sure.' Don't invent an answer. If the question isn't related to the context, state that you are programmed to answer questions relevant to the given context. Remember, you cannot use images or visual content to form your answer. Do the answer in less than 2000 characters.";
    const preparedQuestion = `${instructions}\n\n${question}`;
    const llm = new OpenAI({ modelName: "gpt-3.5-turbo-16k", openAIApiKey });
    const chain = loadQAStuffChain(llm);
    const concatenatedPageContent = queryResponse.matches
      .map((match) => match.metadata?.pageContent ?? "")
      .join(" ");
    const documentLinks = queryResponse.matches.map(
      (match) => match.metadata?.docLink ?? ""
    );
    const result = await chain.call({
      input_documents: [new Document({ pageContent: concatenatedPageContent })],
      question: preparedQuestion,
    });
    console.log(`Answer: ${result.text}`);
    return {
      answer: result.text,
      documentLinks: documentLinks,
    };
  } else {
    console.log("Since there are no matches, GPT-3.5 will not be queried.");
  }
};

/**
 * Creates a Pinecone index with a given name if it does not already exist.
 * @param {PineconeClient} client - The Pinecone client to use for index management.
 * @param {string} indexName - The name of the index to create.
 * @param {number} vectorDimension - The dimensionality of the vector for the index.
 * @param {number} timeout - The timeout in milliseconds to wait for the index to initialize.
 * @returns {Promise<void>}
 */
export const createPineconeIndexIfNotExist = async (
  client: PineconeClient,
  indexName: string,
  vectorDimension: number,
  timeout: number = 180000
) => {
  // Check if the index exists
  console.log(`Checking "${indexName}"...`);
  const existingIndexes = await client.listIndexes();
  // If index does not exist, create it
  if (!existingIndexes.includes(indexName)) {
    // 4. Log index creation initiation
    console.log(`Creating "${indexName}"...`);
    // 5. Create index
    await client.createIndex({
      createRequest: {
        name: indexName,
        dimension: vectorDimension,
        metric: "cosine",
      },
    });
    // 6. Log successful creation
    console.log(
      `Creating index.... please wait for it to finish initializing.`
    );
    // Wait for XXX seconds to let the index initialize
    await new Promise((resolve) => setTimeout(resolve, timeout));
  } else {
    // If the index exists, log that it already exists
    console.log(`"${indexName}" already exists.`);
  }
};

/**
 * Process a single document and return the vectors to be upserted.
 * @param {Document} doc - The document to process.
 * @param {string} openAIApiKey - The API key to use for the OpenAI language model.
 * @returns {Promise<Vector[]>}
 */
const processDocument = async (
  doc: Document,
  openAIApiKey: string
): Promise<Vector[]> => {
  const txtPath = await doc.metadata.source;
  const text = doc.pageContent;

  const documentLinkMatch = text.match(/Link: (.+)/);
  const documentLink = documentLinkMatch ? documentLinkMatch[1] : "";

  const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000 });
  const chunks = await textSplitter.createDocuments([text]);

  const embeddingsArrays = await new OpenAIEmbeddings({
    openAIApiKey,
  }).embedDocuments(
    chunks.map((chunk) => chunk.pageContent.replace(/\n/g, " "))
  );

  return chunks.map((chunk, idx) => ({
    id: `${txtPath}_${idx}`,
    values: embeddingsArrays[idx],
    metadata: {
      ...chunk.metadata,
      loc: JSON.stringify(chunk.metadata.loc),
      pageContent: chunk.pageContent,
      txtPath: txtPath,
      docLink: documentLink,
    },
  }));
};

/**
 * Upserts batches of vectors to a Pinecone index.
 * @param {Index} index - The Pinecone index to update.
 * @param {Vector[]} vectors - The vectors to upsert.
 * @returns {Promise<void>}
 */
const upsertVectors = async (
  index: VectorOperationsApi,
  vectors: Vector[]
): Promise<void> => {
  const batchSize = 100;
  for (let i = 0; i < vectors.length; i += batchSize) {
    const batch = vectors.slice(i, i + batchSize);
    await index.upsert({ upsertRequest: { vectors: batch } });
  }
};

/**
 * Updates a Pinecone index with new vectors created from the provided documents.
 * @param {PineconeClient} client - The Pinecone client to use for index management.
 * @param {string} openAIApiKey - The API key to use for the OpenAI language model.
 * @param {string} indexName - The name of the index to update.
 * @param {Document[]} docs - The documents to use for creating vectors.
 * @returns {Promise<void>}
 */
export const updatePineconeIndex = async (
  client: PineconeClient,
  openAIApiKey: string,
  indexName: string,
  docs: Document[]
): Promise<void> => {
  const index = client.Index(indexName);

  for (const [i, doc] of docs.entries()) {
    const vectors = await processDocument(doc, openAIApiKey);
    await upsertVectors(index, vectors);
    console.log(
      `Processing document ${i + 1} of ${docs.length}, generated ${
        vectors.length
      } vectors`
    );
  }
};

// /**
//  * Updates a Pinecone index with new vectors created from the provided documents.
//  * @param {PineconeClient} client - The Pinecone client to use for index management.
//  * @param {string} openAIApiKey - The API key to use for the OpenAI language model.
//  * @param {string} indexName - The name of the index to update.
//  * @param {Document[]} docs - The documents to use for creating vectors.
//  * @returns {Promise<void>}
//  */
// export const updatePineconeIndex2 = async (
//   client: PineconeClient,
//   openAIApiKey: string,
//   indexName: string,
//   docs: Document[]
// ) => {
//   console.log("Retrieving Pinecone index...");
//   // Retrieve the specific Pinecone index
//   const index = client.Index(indexName);
//   console.log(`Pinecone index retrieved: ${indexName}`);

//   // Process each document in the docs array
//   for (const doc of docs) {
//     console.log(`Processing document: ${doc.metadata.source}`);
//     const txtPath = await doc.metadata.source;
//     const text = doc.pageContent;

//     const documentLinkMatch = text.match(/Link: (.+)/);
//     const documentLink = documentLinkMatch ? documentLinkMatch[1] : "";

//     // Create an instance of RecursiveCharacterTextSplitter
//     const textSplitter = new RecursiveCharacterTextSplitter({
//       chunkSize: 1000,
//     });
//     console.log("Splitting text into chunks...");
//     // Split text into chunks (documents)
//     const chunks = await textSplitter.createDocuments([text]);
//     console.log(`Text split into ${chunks.length} chunks`);
//     console.log(
//       `Calling OpenAI's Embedding endpoint documents with ${chunks.length} text chunks ...`
//     );
//     // Create embeddings for the documents
//     const embeddingsArrays = await new OpenAIEmbeddings({
//       openAIApiKey,
//     }).embedDocuments(
//       chunks.map((chunk) => chunk.pageContent.replace(/\n/g, " "))
//     );
//     console.log("Finished embedding documents");
//     console.log(
//       `Creating ${chunks.length} vectors array with id, values, and metadata...`
//     );
//     // Create and upsert vectors in batches of 100
//     const batchSize = 100;
//     let batch: Vector[] = [];
//     for (let idx = 0; idx < chunks.length; idx++) {
//       const chunk = chunks[idx];
//       const vector = {
//         id: `${txtPath}_${idx}`,
//         values: embeddingsArrays[idx],
//         metadata: {
//           ...chunk.metadata,
//           loc: JSON.stringify(chunk.metadata.loc),
//           pageContent: chunk.pageContent,
//           txtPath: txtPath,
//           docLink: documentLink,
//         },
//       };
//       batch = [...batch, vector];
//       // When batch is full or it's the last item, upsert the vectors
//       if (batch.length === batchSize || idx === chunks.length - 1) {
//         await index.upsert({
//           upsertRequest: {
//             vectors: batch,
//           },
//         });
//         // Empty the batch
//         batch = [];
//       }
//     }
//     // Log the number of vectors updated
//     console.log(`Pinecone index updated with ${chunks.length} vectors`);
//   }
// };
