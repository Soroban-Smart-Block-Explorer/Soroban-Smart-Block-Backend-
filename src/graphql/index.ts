import { createYoga } from 'graphql-yoga';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { typeDefs } from './schema';
import { resolvers } from './resolvers';
import { subscriptionResolvers } from './subscriptions';
import { createContext } from './context';
import { complexityPlugin, depthLimitPlugin } from './plugins';

export const schema = makeExecutableSchema({
  typeDefs,
  resolvers: {
    ...resolvers,
    Subscription: subscriptionResolvers,
  },
});

// GraphiQL IDE is disabled in production unless ENABLE_GRAPHIQL=true.
const graphiqlEnabled =
  process.env.NODE_ENV !== 'production' || process.env.ENABLE_GRAPHIQL === 'true';

const yoga = createYoga({
  schema,
  context: createContext,
  plugins: [complexityPlugin, depthLimitPlugin],
  graphqlEndpoint: '/api/graphql',
  graphiql: graphiqlEnabled
    ? {
        title: 'Soroban Explorer GraphQL API',
        defaultQuery: `# Welcome to the Soroban Explorer GraphQL API
# Example: fetch the latest 5 transactions
query LatestTransactions {
  transactions(limit: 5) {
    data {
      hash
      ledgerSequence
      sourceAccount
      functionName
      status
    }
    hasNext
  }
}

# Example: fetch a contract with its recent events
query ContractDetails($address: ID!) {
  contract(address: $address) {
    name
    isToken
    transactions(limit: 5) {
      data { hash functionName status }
    }
    events(limit: 5) {
      data { eventType topicSymbol ledgerSequence }
    }
  }
}`,
      }
    : false,
  logging: false,
});

export default yoga;
