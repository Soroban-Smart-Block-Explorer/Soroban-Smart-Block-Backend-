import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { AuthProvider, useAuth } from './src/auth/AuthContext';
import { LockScreen } from './src/screens/LockScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { PremiumScreen } from './src/screens/PremiumScreen';

const Tab = createBottomTabNavigator();

function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Soroban Explorer</Text>
      <Text style={styles.subtitle}>Mobile SDK Active</Text>
    </View>
  );
}

function WalletScreen() {
  const { address } = useAuth();
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Wallet View</Text>
      {address ? <Text style={styles.subtitle}>{address}</Text> : null}
    </View>
  );
}

function ContractScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Contract View</Text>
    </View>
  );
}

function AlertsScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Alerts</Text>
    </View>
  );
}

function SettingsScreen() {
  const { signOut, address } = useAuth();
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Settings</Text>
      {address ? <Text style={styles.subtitle}>{address}</Text> : null}
      <Text style={[styles.subtitle, styles.link]} onPress={signOut}>
        Sign out
      </Text>
    </View>
  );
}

function HomeTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#0f172a' },
        headerTintColor: '#f8fafc',
        tabBarStyle: { backgroundColor: '#0f172a', borderTopColor: '#1e293b' },
        tabBarActiveTintColor: '#3b82f6',
        tabBarInactiveTintColor: '#64748b',
      }}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Wallet" component={WalletScreen} />
      <Tab.Screen name="Contracts" component={ContractScreen} />
      <Tab.Screen name="Alerts" component={AlertsScreen} />
      <Tab.Screen name="Premium" component={PremiumScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

function AuthGate() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    );
  }

  if (status === 'signed-out') return <LoginScreen />;
  if (status === 'locked') return <LockScreen />;

  return (
    <NavigationContainer
      linking={{
        prefixes: ['soroban://', 'https://soroban.network'],
        config: {
          screens: {
            Home: '',
            Wallet: 'wallet/:address',
            Contracts: 'contract/:address',
            Alerts: 'alerts',
            Premium: 'premium',
            Settings: 'settings',
          },
        },
      }}
    >
      <HomeTabs />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#f8fafc',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748b',
    marginTop: 8,
  },
  link: {
    color: '#3b82f6',
    marginTop: 24,
  },
  loading: {
    flex: 1,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
